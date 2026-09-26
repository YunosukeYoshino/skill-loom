/**
 * skills.sh の非公式検索 API を叩いて source(repo) 単位にまとめる。
 * `npx skills find` が内部で使う `GET /api/search` と同じ endpoint。無認証だが
 * 公式契約ではないので、壊れたら直す前提の薄いプロキシに留める。
 *
 * TTL キャッシュが本体。制限値が undocumented なので同じ q を短時間に連発
 * しないよう 5 分でまとめる。失敗はキャッシュしない（一時的な失敗を引き
 * ずらないため、ogp.ts と同じ方針）。
 */

const TTL_MS = 5 * 60 * 1000;
const FETCH_LIMIT = 100;

export type DiscoverSource = {
  source: string;
  installs: number;
  skills: { skillId: string; name: string; installs: number }[];
};

const cache = new Map<string, { at: number; data: DiscoverSource[] }>();

/** テスト用。TTL 内のキャッシュが残っていると別 fixture の結果を拾ってしまう。 */
export function clearDiscoverCache(): void {
  cache.clear();
}

type SearchResultSkill = {
  source?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
};

export async function searchSkillsSh(
  query: string
): Promise<DiscoverSource[]> {
  const now = Date.now();
  const cached = cache.get(query);
  if (cached && now - cached.at < TTL_MS) return cached.data;

  const params = new URLSearchParams({
    q: query,
    limit: String(FETCH_LIMIT),
  });
  const response = await fetch(`https://skills.sh/api/search?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`HTTP Error ${response.status}: skills.sh search`);
  const payload = (await response.json()) as { skills?: SearchResultSkill[] };
  const skills = Array.isArray(payload.skills) ? payload.skills : [];

  const bySource = new Map<string, DiscoverSource>();
  for (const skill of skills) {
    const source = typeof skill.source === "string" ? skill.source : "";
    if (!source) continue;
    let entry = bySource.get(source);
    if (!entry) {
      entry = { source, installs: 0, skills: [] };
      bySource.set(source, entry);
    }
    const installs = typeof skill.installs === "number" ? skill.installs : 0;
    entry.installs += installs;
    entry.skills.push({
      skillId: typeof skill.skillId === "string" ? skill.skillId : "",
      name: typeof skill.name === "string" ? skill.name : "",
      installs,
    });
  }
  const data = [...bySource.values()].sort((a, b) => b.installs - a.installs);
  cache.set(query, { at: now, data });
  return data;
}
