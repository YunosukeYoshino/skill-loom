/**
 * API クライアントが HTML / 非 JSON の 200 を成功扱いしないことを固定する。
 * Vite 直叩き時に SPA index が返ると、{} を正しいペイロードと誤認して
 * ExternalSourcesPage などが `.map` で落ちる。
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError, api } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api.externalSources", () => {
  test("text/html の 200 は ApiError にする（Vite SPA フォールバック）", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("<!doctype html><html><body>index</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;

    await expect(api.externalSources()).rejects.toBeInstanceOf(ApiError);
    try {
      await api.externalSources();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toMatch(
        /HTML|JSON|Vite|公開ポート|public/i
      );
    }
  });

  test("JSON パース失敗の 200 も ApiError にする", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(api.externalSources()).rejects.toBeInstanceOf(ApiError);
  });

  test("正しい JSON 200 はそのまま返す", async () => {
    const payload = {
      page: "external-sources",
      title: "External sources",
      message: "",
      decks: [],
      sources: [],
      totalUpdatable: 0,
      updateStatusBySource: {},
    };
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(api.externalSources()).resolves.toEqual(payload);
  });
});

describe("project API", () => {
  test("Draft import submits the category, preserves its result and propagates conflicts", async () => {
    const fetcher = mock(async (path: unknown, init?: RequestInit) => {
      expect(String(path)).toBe("/api/projects/my%20repo/skills/local/import");
      expect(JSON.parse(init!.body as string)).toEqual({ category: "team" });
      return new Response(
        '{"importedDraft":{"name":"local","category":"team"}}',
        { headers: { "Content-Type": "application/json" } }
      );
    });
    globalThis.fetch = fetcher as unknown as typeof fetch;
    expect(
      (await api.importProjectSkill("my repo", "local", "team")).importedDraft
        .name
    ).toBe("local");
    globalThis.fetch = mock(
      async () =>
        new Response('{"message":"Skill already exists"}', {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
    await expect(api.importProjectSkill("work", "local")).rejects.toThrow(
      "Skill already exists"
    );
  });
  test("空一覧と差分プレビューの JSON を保持する", async () => {
    globalThis.fetch = mock(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).endsWith("preview")
              ? {
                  skill: "alpha",
                  diff: "-local\n+source",
                  revision: "current",
                  requiresConfirmation: true,
                }
              : { projects: [], inventory: [], decks: [] }
          ),
          { headers: { "Content-Type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(await api.projects()).toEqual({
      projects: [],
      inventory: [],
      decks: [],
    });
    expect(await api.projectSkillPreview("work", "alpha")).toMatchObject({
      diff: "-local\n+source",
      requiresConfirmation: true,
    });
  });
  test("更新で確認済み revision を送信する", async () => {
    const fetcher = mock(async (_path: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({
        force: true,
        revision: "reviewed",
        confirm: true,
      });
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetcher as unknown as typeof fetch;
    await api.projectSkill("work", "alpha", "update", true, "reviewed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test("確認前の更新エラーを伝える", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('{"message":"Review the diff"}', {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
    await expect(api.projectSkill("work", "alpha", "update")).rejects.toThrow(
      "Review the diff"
    );
  });
});
