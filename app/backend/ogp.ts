/**
 * GitHub の repo ページから og:* を拾ってくる。source 一覧のカードに出す絵と説明。
 *
 * `ui/app.py` の `fetch_ogp` と `_OgpMetaParser` の移植。
 *
 * TTL キャッシュが本体。source 一覧は repo ごとに 1 回ずつ叩くので、キャッシュを
 * 外すと画面を開き直すたびに GitHub へ N 本飛ぶ。失敗もキャッシュしないのは移行前と
 * 同じで、一時的な失敗を 6 時間引きずらないため。
 */

const TTL_MS = 6 * 60 * 60 * 1000

export type OgpData = { title: string | null; description: string | null; image: string | null }

const cache = new Map<string, { at: number; data: OgpData }>()

/** テスト用。TTL 内のキャッシュが残っていると別 fixture の結果を拾ってしまう。 */
export function clearOgpCache(): void {
  cache.clear()
}

const META_TAG = /<meta\b[^>]*>/gi
const ATTRIBUTE = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** HTMLParser(convert_charrefs=True) 相当。og:* に出る範囲の実体参照だけ戻す。 */
function decodeCharrefs(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** 属性の並びに依存せず og:* を集める。同じ property が複数あれば先勝ち。 */
export function parseOgpMeta(html: string): Record<string, string> {
  const data: Record<string, string> = {}
  for (const [tag] of html.matchAll(META_TAG)) {
    const attributes: Record<string, string> = {}
    for (const match of tag.matchAll(ATTRIBUTE)) {
      const name = (match[1] as string).toLowerCase()
      if (!(name in attributes)) attributes[name] = decodeCharrefs(match[3] ?? match[4] ?? match[5] ?? "")
    }
    const property = attributes.property || attributes.name || ""
    const content = attributes.content
    if (content && property.startsWith("og:")) {
      const key = property.slice("og:".length)
      if (!(key in data)) data[key] = content
    }
  }
  return data
}

export async function fetchOgp(ownerRepo: string): Promise<OgpData> {
  const now = Date.now()
  const cached = cache.get(ownerRepo)
  if (cached && now - cached.at < TTL_MS) return cached.data

  const response = await fetch(`https://github.com/${ownerRepo}`, { redirect: "follow" })
  if (!response.ok) throw new Error(`HTTP Error ${response.status}: https://github.com/${ownerRepo}`)
  const meta = parseOgpMeta(await response.text())
  const data: OgpData = {
    title: meta.title ?? null,
    description: meta.description ?? null,
    image: meta.image ?? null,
  }
  cache.set(ownerRepo, { at: now, data })
  return data
}
