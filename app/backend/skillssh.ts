/**
 * skills.sh の非公式検索 API を叩いて source(repo) 単位にまとめる。
 * `npx skills find` が内部で使う `GET /api/search` と同じ endpoint。無認証だが
 * 公式契約ではないので、壊れたら直す前提の薄いプロキシに留める。
 *
 * TTL キャッシュが本体。制限値が undocumented なので同じ q を短時間に連発
 * しないよう 5 分でまとめる。失敗はキャッシュしない（一時的な失敗を引き
 * ずらないため、ogp.ts と同じ方針）。
 */

import type { DiscoverSource } from "@shared/api-types";

const TTL_MS = 5 * 60 * 1000;
const FETCH_LIMIT = 100;
const MAX_ENTRIES = 50;

const cache = new Map<string, { at: number; data: DiscoverSource[] }>();

/** テスト用。TTL 内のキャッシュが残っていると別 fixture の結果を拾ってしまう。 */
export function clearDiscoverCache(): void {
  cache.clear();
}

export type SearchResultSkill = {
  source?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
};

/** skill 単位の API レスポンスを source 単位に集約する。installs は合算・降順。 */
export function groupBySource(skills: SearchResultSkill[]): DiscoverSource[] {
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
  return [...bySource.values()].sort((a, b) => b.installs - a.installs);
}

export async function searchSkillsSh(
  query: string
): Promise<DiscoverSource[]> {
  const now = Date.now();
  const cached = cache.get(query);
  if (cached && now - cached.at < TTL_MS) {
    // Map は挿入順を保つので、移し直して LRU に近い退避順にする
    cache.delete(query);
    cache.set(query, cached);
    return cached.data;
  }
  cache.delete(query);

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

  const data = groupBySource(skills);
  cache.set(query, { at: now, data });
  // q はユーザー入力由来で無限に増え得るので、期限切れを掃除してから上限で絞る
  if (cache.size > MAX_ENTRIES) {
    for (const [key, entry] of cache) {
      if (now - entry.at >= TTL_MS) cache.delete(key);
    }
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return data;
}
