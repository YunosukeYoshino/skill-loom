/**
 * OGP メタタグの取り出しのテスト。
 *
 * GitHub の HTML は属性の並びが安定しないので、`property` と `name` のどちらでも拾い、
 * 並び順に依存しないことを固定する。取り違えるとカードの画像だけが消える。
 */

import { describe, expect, test } from "bun:test"
import { parseOgpMeta } from "./ogp"

describe("parseOgpMeta", () => {
  test("property でも name でも拾い、属性の並びには依存しない", () => {
    const html = `
      <meta property="og:title" content="owner/repo">
      <meta content="A description" name="og:description">
      <meta name='og:image' content='https://example.test/card.png' />
      <meta name="twitter:card" content="summary">
      <meta property="og:empty" content="">
    `
    expect(parseOgpMeta(html)).toEqual({
      title: "owner/repo",
      description: "A description",
      image: "https://example.test/card.png",
    })
  })

  test("同じ property が複数あれば先勝ち", () => {
    const html = '<meta property="og:title" content="first"><meta property="og:title" content="second">'
    expect(parseOgpMeta(html).title).toBe("first")
  })

  test("実体参照は戻してから返す", () => {
    const html = '<meta property="og:description" content="a &amp; b &#39;c&#39;">'
    expect(parseOgpMeta(html).description).toBe("a & b 'c'")
  })
})
