/**
 * Python の `difflib` のうち、SKILL.md の unified diff に必要な部分だけを移す。
 *
 * 汎用の diff ライブラリでは差分の切り方が変わる。difflib は最小編集距離ではなく
 * 「最長一致ブロックで再帰的に割る」ので、同じ入力でも Myers 系とはハンク境界が
 * ずれる。UI に出る diff が移行前と 1 文字でも変わらないよう、アルゴリズムごと
 * 写している。
 */

/**
 * `str.splitlines()` が区切りとして扱う文字。`split("\n")` では足りない。
 * CRLF を先に並べないと 2 行に割れる。
 */
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/

/**
 * `str.splitlines()` 相当。末尾の改行では空要素を作らない。
 * `split("\n")` にすると末尾の空行が 1 行として差分に出てしまう。
 */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(LINE_BOUNDARY)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

type Match = { i: number; j: number; size: number }
type OpTag = "equal" | "replace" | "delete" | "insert"
type Opcode = [OpTag, number, number, number, number]

/**
 * `SequenceMatcher(None, a, b)` 相当。isjunk は使わないが autojunk は効かせる。
 * autojunk を落とすと、行数の多いファイルで difflib と結果が変わる。
 */
class SequenceMatcher {
  private readonly a: string[]
  private readonly b: string[]
  private readonly b2j = new Map<string, number[]>()
  private readonly bjunk = new Set<string>()

  constructor(a: string[], b: string[]) {
    this.a = a
    this.b = b
    for (let i = 0; i < b.length; i++) {
      const line = b[i] as string
      const indices = this.b2j.get(line)
      if (indices) indices.push(i)
      else this.b2j.set(line, [i])
    }
    // 200 行以上では、1% を超えて現れる行を「ありふれた行」として一致候補から外す。
    if (b.length >= 200) {
      const threshold = Math.floor(b.length / 100) + 1
      const popular: string[] = []
      for (const [line, indices] of this.b2j) {
        if (indices.length > threshold) popular.push(line)
      }
      for (const line of popular) this.b2j.delete(line)
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    let besti = alo
    let bestj = blo
    let bestsize = 0
    let j2len = new Map<number, number>()

    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>()
      for (const j of this.b2j.get(this.a[i] as string) ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        newj2len.set(j, k)
        if (k > bestsize) {
          besti = i - k + 1
          bestj = j - k + 1
          bestsize = k
        }
      }
      j2len = newj2len
    }

    // 一致の前後を junk でない行で伸ばし、そのあと junk も吸わせる。
    while (besti > alo && bestj > blo && !this.bjunk.has(this.b[bestj - 1] as string) && this.a[besti - 1] === this.b[bestj - 1]) {
      besti--
      bestj--
      bestsize++
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !this.bjunk.has(this.b[bestj + bestsize] as string) &&
      this.a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize++
    }
    while (besti > alo && bestj > blo && this.bjunk.has(this.b[bestj - 1] as string) && this.a[besti - 1] === this.b[bestj - 1]) {
      besti--
      bestj--
      bestsize++
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      this.bjunk.has(this.b[bestj + bestsize] as string) &&
      this.a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize++
    }

    return { i: besti, j: bestj, size: bestsize }
  }

  private getMatchingBlocks(): Match[] {
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]]
    const blocks: Match[] = []
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number]
      const match = this.findLongestMatch(alo, ahi, blo, bhi)
      if (match.size === 0) continue
      blocks.push(match)
      if (alo < match.i && blo < match.j) queue.push([alo, match.i, blo, match.j])
      if (match.i + match.size < ahi && match.j + match.size < bhi) {
        queue.push([match.i + match.size, ahi, match.j + match.size, bhi])
      }
    }
    blocks.sort((left, right) => left.i - right.i || left.j - right.j || left.size - right.size)

    // 隣り合うブロックは 1 つに畳む。畳まないと余計な equal が挟まる。
    const merged: Match[] = []
    let current: Match = { i: 0, j: 0, size: 0 }
    for (const block of blocks) {
      if (current.i + current.size === block.i && current.j + current.size === block.j) {
        current = { i: current.i, j: current.j, size: current.size + block.size }
      } else {
        if (current.size > 0) merged.push(current)
        current = block
      }
    }
    if (current.size > 0) merged.push(current)
    merged.push({ i: this.a.length, j: this.b.length, size: 0 })
    return merged
  }

  getOpcodes(): Opcode[] {
    let i = 0
    let j = 0
    const opcodes: Opcode[] = []
    for (const block of this.getMatchingBlocks()) {
      let tag: OpTag | "" = ""
      if (i < block.i && j < block.j) tag = "replace"
      else if (i < block.i) tag = "delete"
      else if (j < block.j) tag = "insert"
      if (tag) opcodes.push([tag, i, block.i, j, block.j])
      i = block.i + block.size
      j = block.j + block.size
      if (block.size > 0) opcodes.push(["equal", block.i, i, block.j, j])
    }
    return opcodes
  }

  /** `get_grouped_opcodes(n)` 相当。変更の周りに n 行だけ文脈を残して切る。 */
  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes()
    if (codes.length === 0) codes = [["equal", 0, 1, 0, 1]]

    const first = codes[0] as Opcode
    if (first[0] === "equal") {
      codes[0] = ["equal", Math.max(first[1], first[2] - n), first[2], Math.max(first[3], first[4] - n), first[4]]
    }
    const last = codes[codes.length - 1] as Opcode
    if (last[0] === "equal") {
      codes[codes.length - 1] = ["equal", last[1], Math.min(last[2], last[1] + n), last[3], Math.min(last[4], last[3] + n)]
    }

    const groups: Opcode[][] = []
    let group: Opcode[] = []
    for (const code of codes) {
      let [tag, i1, i2, j1, j2] = code
      // 変更のない範囲が長ければ、そこでハンクを切る。
      if (tag === "equal" && i2 - i1 > n + n) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)])
        groups.push(group)
        group = []
        i1 = Math.max(i1, i2 - n)
        j1 = Math.max(j1, j2 - n)
      }
      group.push([tag, i1, i2, j1, j2])
    }
    if (group.length > 0 && !(group.length === 1 && (group[0] as Opcode)[0] === "equal")) groups.push(group)
    return groups
  }
}

/** `_format_range_unified` 相当。1 行なら長さを省き、0 行なら開始を 1 つ戻す。 */
function formatRange(start: number, stop: number): string {
  const length = stop - start
  if (length === 1) return String(start + 1)
  return `${length === 0 ? start : start + 1},${length}`
}

/**
 * `difflib.unified_diff(..., lineterm="")` 相当を 1 本の文字列で返す。
 * 差分が無ければ空文字。
 */
export function unifiedDiff(a: string[], b: string[], fromFile: string, toFile: string, n = 3): string {
  const lines: string[] = []
  for (const group of new SequenceMatcher(a, b).getGroupedOpcodes(n)) {
    if (lines.length === 0) {
      lines.push(`--- ${fromFile}`, `+++ ${toFile}`)
    }
    const head = group[0] as Opcode
    const tail = group[group.length - 1] as Opcode
    lines.push(`@@ -${formatRange(head[1], tail[2])} +${formatRange(head[3], tail[4])} @@`)

    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) lines.push(` ${line}`)
        continue
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) lines.push(`-${line}`)
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) lines.push(`+${line}`)
      }
    }
  }
  return lines.join("\n")
}
