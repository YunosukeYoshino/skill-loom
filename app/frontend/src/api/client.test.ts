/**
 * API クライアントが HTML / 非 JSON の 200 を成功扱いしないことを固定する。
 * Vite 直叩き時に SPA index が返ると、{} を正しいペイロードと誤認して
 * ExternalSourcesPage などが `.map` で落ちる。
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { ApiError, api } from "./client"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("api.externalSources", () => {
  test("text/html の 200 は ApiError にする（Vite SPA フォールバック）", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("<!doctype html><html><body>index</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }) as unknown as typeof fetch

    await expect(api.externalSources()).rejects.toBeInstanceOf(ApiError)
    try {
      await api.externalSources()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toMatch(/HTML|JSON|Vite|公開ポート|public/i)
    }
  })

  test("JSON パース失敗の 200 も ApiError にする", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    await expect(api.externalSources()).rejects.toBeInstanceOf(ApiError)
  })

  test("正しい JSON 200 はそのまま返す", async () => {
    const payload = {
      page: "external-sources",
      title: "External sources",
      message: "",
      decks: [],
      sources: [],
      totalUpdatable: 0,
      updateStatusBySource: {},
    }
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    await expect(api.externalSources()).resolves.toEqual(payload)
  })
})
