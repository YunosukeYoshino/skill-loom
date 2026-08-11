/**
 * GitHub 側を見るところ。候補の発見と「更新があるか」の判定。
 *
 * `bin/my-skills.py` の GitHub 系ヘルパの移植。ここだけがネットワークに出るので、
 * テストは `MY_SKILLS_EXTERNAL_CANDIDATES_FILE` で候補一覧を差し替えて素通りさせる。
 *
 * 更新判定は 2 段構え:
 *  1. skills CLI の lock（`~/.agents/.skill-lock.json`）に folder hash があれば、
 *     GitHub の git tree SHA と突き合わせる。CLI 自身の判定と完全に同じ土俵に乗る。
 *  2. lock に情報が無ければ SKILL.md の内容ハッシュを比較する。
 *
 * 1 を飛ばして 2 だけにすると、CLI が「最新」と見なすものを UI が「更新あり」と
 * 言い続けて、押しても何も起きないボタンが残る。
 */

import { type Dirent, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { CLI_SKILL_MD_PRIORITY_PREFIXES, externalCandidatesFile, remoteSkillFetchTimeout } from "../domain/config"
import { ValueError } from "../domain/errors"
import { frontmatterDescription, loadGlobalLock } from "../domain/inventory"

// ---- 型 ----

/** 外部 skill 1 件分の候補。`path` はリポジトリルートからの SKILL.md の相対パス。 */
export type ExternalCandidate = {
  name: string
  description?: string
  path?: string
  contentHash?: string
}

type TreeEntry = { path?: string; type?: string; sha?: string }

/** HTTP のステータスを持ったまま投げる。404 のときだけ skillPath の自動修復を試みるため。 */
export class HttpError extends Error {
  readonly code: number
  constructor(code: number, url: string) {
    super(`HTTP Error ${code}: ${url}`)
    this.code = code
  }
}

// ---- source の正規化 ----

const GITHUB_SOURCE_PATTERN = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

export function normalizeGithubSource(source: string): string {
  const match = GITHUB_SOURCE_PATTERN.exec(source.trim())
  if (!match?.[1]) throw new ValueError(`GitHub URL or owner/repo expected: ${source}`)
  return match[1]
}

export function githubRawSkillUrl(ownerRepo: string, skillPath: string): string {
  const [owner = "", repo = ""] = splitOwnerRepo(ownerRepo)
  const quotedPath = skillPath.split("/").filter(Boolean).join("/")
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${quotedPath}`
}

/** Python の `str.partition("/")` と同じで、区切りが無ければ全体が前半。 */
function splitOwnerRepo(ownerRepo: string): [string, string] {
  const index = ownerRepo.indexOf("/")
  if (index < 0) return [ownerRepo, ""]
  return [ownerRepo.slice(0, index), ownerRepo.slice(index + 1)]
}

// ---- 認証 ----

/**
 * GitHub API 用のヘッダ。トークンが取れなくても匿名で続ける（レート制限は低いが動く）。
 * `gh auth token` はサブプロセスなので、取れた値はプロセス内で使い回す。
 */
let cachedToken: string | null = null

export function githubAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "my-skills",
    Accept: "application/vnd.github+json",
  }
  if (cachedToken === null) {
    let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
    if (!token) {
      try {
        const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" })
        token = result.exitCode === 0 ? result.stdout.toString().trim() : ""
      } catch {
        token = ""
      }
    }
    cachedToken = token
  }
  if (cachedToken) headers.Authorization = `Bearer ${cachedToken}`
  return headers
}

// ---- git tree（更新判定の 1 段目）----

const treeCache = new Map<string, TreeEntry[]>()

/** 更新確認の一括実行ごとに捨てる。持ち越すと「更新した直後に更新あり」が出続ける。 */
export function clearGithubTreeShaCache(): void {
  treeCache.clear()
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(remoteSkillFetchTimeout() * 1000),
  })
  if (!response.ok) throw new HttpError(response.status, url)
  return response.json()
}

/** owner/repo@ref 単位でキャッシュする。1 回の更新確認で同じ repo を何度も引くため。 */
export async function fetchGithubRepoTree(ownerRepo: string, ref = "HEAD"): Promise<TreeEntry[]> {
  const normalized = normalizeGithubSource(ownerRepo)
  const refValue = ref || "HEAD"
  const cacheKey = `${normalized}@${refValue}`
  const cached = treeCache.get(cacheKey)
  if (cached) return cached

  const [owner, repo] = splitOwnerRepo(normalized)
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${refValue}?recursive=1`
  const payload = (await fetchJson(url, githubAuthHeaders())) as { tree?: unknown }
  const tree = Array.isArray(payload.tree)
    ? (payload.tree.filter((entry) => typeof entry === "object" && entry !== null) as TreeEntry[])
    : []
  treeCache.set(cacheKey, tree)
  return tree
}

/** `bunx skills` と同じく、SKILL.md を含むフォルダのパスを tree SHA の比較キーにする。 */
export function skillMdFolderPath(skillPath: string): string {
  let folderPath = skillPath.replace(/\\/g, "/")
  const lower = folderPath.toLowerCase()
  if (lower.endsWith("/skill.md")) folderPath = folderPath.slice(0, -9)
  else if (lower.endsWith("skill.md")) folderPath = folderPath.slice(0, -8)
  return folderPath.replace(/\/+$/, "")
}

/**
 * `bunx skills` の findSkillMdPaths と同じ発見規則。
 *
 * 優先 prefix ごとに「直下の SKILL.md」「1 階層下」「（prefix があるときだけ）2 階層下」を
 * 拾う。2 階層下は親に SKILL.md が無いときだけで、これは CLI が親を skill 本体、
 * 子を補助ファイル置き場と見なす挙動に合わせている。
 */
export function findCliSkillMdPaths(tree: TreeEntry[], subpath = ""): string[] {
  const allSkillMds = tree
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string)
    .filter((path) => path.toLowerCase().endsWith("skill.md"))

  const prefix = subpath ? (subpath.endsWith("/") ? subpath : `${subpath}/`) : ""
  const filtered = prefix
    ? allSkillMds.filter((path) => path.startsWith(prefix) || path === `${prefix}SKILL.md`)
    : allSkillMds
  if (filtered.length === 0) return []

  const priorityResults: string[] = []
  const seen = new Set<string>()
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", "__pycache__"])
  const lowerSkillMdSet = new Set(filtered.map((path) => path.toLowerCase()))

  for (const priorityPrefix of CLI_SKILL_MD_PRIORITY_PREFIXES) {
    const fullPrefix = prefix + priorityPrefix
    const isContainer = priorityPrefix !== ""
    for (const skillMd of filtered) {
      if (!skillMd.startsWith(fullPrefix)) continue
      const rest = skillMd.slice(fullPrefix.length)
      if (rest.toLowerCase() === "skill.md") {
        if (!seen.has(skillMd)) {
          priorityResults.push(skillMd)
          seen.add(skillMd)
        }
        continue
      }
      const parts = rest.split("/")
      if (parts.length === 2 && parts[1]?.toLowerCase() === "skill.md") {
        if (!seen.has(skillMd)) {
          priorityResults.push(skillMd)
          seen.add(skillMd)
        }
        continue
      }
      if (
        isContainer &&
        parts.length === 3 &&
        parts[2]?.toLowerCase() === "skill.md" &&
        !skipDirs.has(parts[0] as string) &&
        !skipDirs.has(parts[1] as string)
      ) {
        const parentSkillMd = `${fullPrefix}${parts[0]}/SKILL.md`.toLowerCase()
        if (!lowerSkillMdSet.has(parentSkillMd) && !seen.has(skillMd)) {
          priorityResults.push(skillMd)
          seen.add(skillMd)
        }
      }
    }
  }

  if (priorityResults.length > 0) return priorityResults
  return filtered.filter((path) => path.split("/").length <= 6)
}

export async function fetchRemoteSkillContentHash(ownerRepo: string, skillPath: string): Promise<string> {
  const url = githubRawSkillUrl(ownerRepo, skillPath)
  const response = await fetch(url, {
    headers: { "User-Agent": "my-skills" },
    signal: AbortSignal.timeout(remoteSkillFetchTimeout() * 1000),
  })
  if (!response.ok) throw new HttpError(response.status, url)
  return sha256(new Uint8Array(await response.arrayBuffer()))
}

/**
 * skills CLI が「更新が要る」と見なすかどうか。
 *
 * CLI の lock に必要な情報が揃っていなければ null を返す。呼び出し側は内容ハッシュへ
 * フォールバックする。null と false を取り違えると、フォールバックが効かなくなる。
 */
export async function cliSkillNeedsUpdate(name: string): Promise<boolean | null> {
  const entry = loadGlobalLock()[name]
  if (!entry || typeof entry !== "object") return null

  const folderHash = String(entry.skillFolderHash ?? "")
  const skillPath = String(entry.skillPath ?? "")
  const source = String(entry.source ?? "")
  if (!folderHash || !skillPath || !source) return null

  const sourceType = String(entry.sourceType ?? "")
  if (sourceType !== "github" && sourceType !== "") return null

  let remoteSha = ""
  try {
    const ownerRepo = normalizeGithubSource(source)
    const ref = String(entry.ref ?? "") || "HEAD"
    const tree = await fetchGithubRepoTree(ownerRepo, ref)
    // CLI は見つからない skillPath を「削除済み」とみなして更新しない。
    if (!new Set(findCliSkillMdPaths(tree)).has(skillPath)) return false
    const folder = skillMdFolderPath(skillPath)
    for (const row of tree) {
      if (row.type === "tree" && row.path === folder && row.sha) {
        remoteSha = String(row.sha)
        break
      }
    }
  } catch {
    return null
  }
  if (!remoteSha) return false
  return remoteSha !== folderHash
}

// ---- 候補の発見 ----

export function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex")
}

export function skillFileHash(path: string): string {
  try {
    return sha256(readFileSync(path))
  } catch {
    return ""
  }
}

/** frontmatter の `name:`。無ければ空文字で、呼び出し側は候補から落とす。 */
export function frontmatterName(path: string): string {
  let lines: string[]
  try {
    lines = readFileSync(path, "utf-8").split(/\r\n|\r|\n/)
  } catch {
    return ""
  }
  if (lines[0]?.trim() !== "---") return ""
  for (const line of lines.slice(1)) {
    const stripped = line.trim()
    if (stripped === "---") break
    if (stripped.startsWith("name:")) {
      return stripped.slice("name:".length).trim().replace(/^["']+/, "").replace(/["']+$/, "")
    }
  }
  return ""
}

/** サンプルやテスト用の SKILL.md を install 候補に出さない。 */
export function isInstallableSkillPath(relativePath: string): boolean {
  const ignored = new Set(["samples", "fixtures", "testdata", "tests"])
  return !relativePath.split(sep).some((part) => ignored.has(part))
}

/** 同名候補の優先度。CLI の探索順にどれだけ近いかで決まる。小さいほど優先。 */
export function skillMdPathPriority(path: string): [number, string] {
  const normalized = path.replace(/\\/g, "/")
  for (const [index, prefix] of CLI_SKILL_MD_PRIORITY_PREFIXES.entries()) {
    if (prefix === "") {
      const parts = normalized.split("/")
      if (normalized.toLowerCase() === "skill.md" || (parts.length === 2 && parts[1]?.toLowerCase() === "skill.md")) {
        return [index, normalized]
      }
      continue
    }
    if (normalized.startsWith(prefix)) return [index, normalized]
  }
  return [CLI_SKILL_MD_PRIORITY_PREFIXES.length, normalized]
}

function priorityLessThan(a: [number, string], b: [number, string]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0]
  return a[1] < b[1]
}

/** 名前ごとに最優先のパスだけ残す。並びは最初に見つかった順（Python の dict と同じ）。 */
export function uniqueExternalSkillCandidates(candidates: ExternalCandidate[]): ExternalCandidate[] {
  const bestByName = new Map<string, [[number, string], ExternalCandidate]>()
  for (const candidate of candidates) {
    const name = candidate.name || ""
    if (!name) continue
    const priority = skillMdPathPriority(candidate.path || "")
    const existing = bestByName.get(name)
    if (existing === undefined || priorityLessThan(priority, existing[0])) {
      bestByName.set(name, [priority, candidate])
    }
  }
  return [...bestByName.values()].map((entry) => entry[1])
}

/** Python の `sorted(repo_dir.rglob("SKILL.md"))` と同じ並びになるよう、フルパスで整列する。 */
function findSkillMdFiles(repoDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === "SKILL.md") found.push(path)
    }
  }
  walk(repoDir)
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function discoverExternalSkillCandidates(repoDir: string): ExternalCandidate[] {
  const light: ExternalCandidate[] = []
  const pathByRel = new Map<string, string>()
  for (const path of findSkillMdFiles(repoDir)) {
    const relativePath = relative(repoDir, path)
    if (!isInstallableSkillPath(relativePath)) continue
    const name = frontmatterName(path)
    if (!name) continue
    pathByRel.set(relativePath, path)
    light.push({ name, path: relativePath })
  }

  return uniqueExternalSkillCandidates(light).map((candidate) => {
    const path = pathByRel.get(candidate.path as string) as string
    return {
      name: candidate.name,
      description: frontmatterDescription(path),
      path: candidate.path as string,
      contentHash: skillFileHash(path),
    }
  })
}

/**
 * source の skill 候補一覧。
 *
 * `MY_SKILLS_EXTERNAL_CANDIDATES_FILE` があればそれを読む。無ければ shallow clone して
 * SKILL.md を探す。clone は候補一覧を出すためだけなので depth 1 で十分。
 */
export function externalSkillCandidates(source: string): ExternalCandidate[] {
  const fixture = externalCandidatesFile()
  if (fixture) {
    return uniqueExternalSkillCandidates(JSON.parse(readFileSync(fixture, "utf-8")) as ExternalCandidate[])
  }
  const ownerRepo = normalizeGithubSource(source)
  const tmp = mkdtempSync(join(tmpdir(), "my-skills-import-"))
  const repoDir = join(tmp, "repo")
  try {
    const clone = Bun.spawnSync(
      ["git", "clone", "--depth", "1", `https://github.com/${ownerRepo}.git`, repoDir],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (clone.exitCode !== 0) {
      throw new ValueError(`git clone failed: ${clone.stderr.toString().trim() || ownerRepo}`)
    }
    return discoverExternalSkillCandidates(repoDir)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** ローカルに install 済みの SKILL.md の内容ハッシュ。active を先に見るのは Python と同じ。 */
export function installedSkillContentHash(dirs: string[], name: string): string {
  for (const base of dirs) {
    const hash = skillFileHash(join(base, name, "SKILL.md"))
    if (hash) return hash
  }
  return ""
}
