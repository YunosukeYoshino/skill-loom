import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * リスト系ページで URL に反映する共通の表示状態。
 * filter(q) / sort / dir / view は共有スキーマ、catalog は従来どおり真偽値。
 */
export type ListViewSearch = {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  view?: "grid" | "list";
  catalog?: boolean;
};

export function validateListViewSearch(
  search: Record<string, unknown>
): ListViewSearch {
  const dir =
    search.dir === "desc" ? "desc" : search.dir === "asc" ? "asc" : undefined;
  const view =
    search.view === "grid" || search.view === "list" ? search.view : undefined;
  return {
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    sort:
      typeof search.sort === "string" && search.sort ? search.sort : undefined,
    dir,
    view,
    catalog:
      search.catalog === true || search.catalog === "1" || search.catalog === 1
        ? true
        : undefined,
  };
}

/**
 * リストの表示状態 (filter / sort / view) を URL search params にミラーする hook。
 * TopSearch・SearchField・ソート切替・表示モード切替がこの setter を呼ぶことで
 * リロード・共有・戻る進むで状態が復元される。
 */
export function useListViewSearch(): [
  ListViewSearch,
  (patch: Partial<ListViewSearch>) => void,
] {
  // strict:false — validateSearch を持たないルートでも undefined を返すだけ。
  const search = (useSearch({ strict: false }) ?? {}) as ListViewSearch;
  const navigate = useNavigate();

  const patch = useCallback(
    (next: Partial<ListViewSearch>) => {
      void navigate({
        to: ".",
        search: (prev: ListViewSearch): ListViewSearch => {
          const merged: Record<string, unknown> = { ...prev, ...next };
          for (const key of Object.keys(merged)) {
            if (merged[key] === undefined || merged[key] === "") {
              delete merged[key];
            }
          }
          return merged as ListViewSearch;
        },
        replace: true,
      });
    },
    [navigate]
  );

  return [search, patch];
}
