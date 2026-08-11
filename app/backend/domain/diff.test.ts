/**
 * unified diff のテスト。
 *
 * 期待値は移行前の Python で `difflib.unified_diff(..., lineterm="")` を実行して
 * 採った文字列をそのまま置いている。ハンクヘッダの `,length` の省略規則や、
 * 変更が離れているときの切り方が 1 文字でも変わると UI の diff が変わるので、
 * 目視で書き起こさずに実出力を固定する。
 */

import { describe, expect, test } from "bun:test";
import { splitLines, unifiedDiff } from "./diff";

const FROM = "installed/gamma/SKILL.md";
const TO = "repo/gamma/SKILL.md";

const diff = (a: string[], b: string[]) => unifiedDiff(a, b, FROM, TO);
const range = (n: number) =>
  Array.from({ length: n }, (_, index) => `l${index + 1}`);

describe("splitLines", () => {
  test("末尾の改行では空行を作らない", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    // 空行そのものは残す。落とすと diff の行数がずれる。
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  test("CRLF は 1 つの区切りとして扱う", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("unifiedDiff", () => {
  test("差分が無ければ空文字（ヘッダも出さない）", () => {
    expect(diff(["a", "b"], ["a", "b"])).toBe("");
    expect(diff([], [])).toBe("");
  });

  test("1 行の置換", () => {
    expect(diff(["a", "b", "c"], ["a", "B", "c"])).toBe(
      `--- ${FROM}\n+++ ${TO}\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c`
    );
  });

  test("挿入と削除で片側の行数だけが動く", () => {
    expect(diff(["a", "c"], ["a", "b", "c"])).toBe(
      `--- ${FROM}\n+++ ${TO}\n@@ -1,2 +1,3 @@\n a\n+b\n c`
    );
    expect(diff(["a", "b", "c"], ["a", "c"])).toBe(
      `--- ${FROM}\n+++ ${TO}\n@@ -1,3 +1,2 @@\n a\n-b\n c`
    );
  });

  test("片側が空なら長さ 0 の範囲になり、開始が 1 つ戻る", () => {
    expect(diff([], ["a", "b"])).toBe(
      `--- ${FROM}\n+++ ${TO}\n@@ -0,0 +1,2 @@\n+a\n+b`
    );
    expect(diff(["a", "b"], [])).toBe(
      `--- ${FROM}\n+++ ${TO}\n@@ -1,2 +0,0 @@\n-a\n-b`
    );
  });

  test("変更が離れていればハンクを分ける", () => {
    const a = range(20);
    const b = range(20);
    b[1] = "X";
    b[17] = "Y";
    expect(diff(a, b)).toBe(
      `--- ${FROM}\n+++ ${TO}\n` +
        "@@ -1,5 +1,5 @@\n l1\n-l2\n+X\n l3\n l4\n l5\n" +
        "@@ -15,6 +15,6 @@\n l15\n l16\n l17\n-l18\n+Y\n l19\n l20"
    );
  });

  test("1 行だけの範囲は長さを省く", () => {
    // `@@ -1 +1 @@` の形。`,1` を付けると移行前の出力と変わる。
    expect(diff(["a"], ["b"])).toBe(
      `--- ${FROM}\n+++ ${TO}\n@@ -1 +1 @@\n-a\n+b`
    );
  });
});
