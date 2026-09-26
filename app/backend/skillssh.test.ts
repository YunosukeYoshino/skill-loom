import { describe, expect, test } from "bun:test";
import { groupBySource } from "./skillssh";

describe("groupBySource", () => {
  test("同じ source の skill をまとめて installs を合算し、合算値の降順に並べる", () => {
    const results = groupBySource([
      { source: "b/repo", skillId: "x", name: "x", installs: 10 },
      { source: "a/repo", skillId: "y", name: "y", installs: 100 },
      { source: "b/repo", skillId: "z", name: "z", installs: 5 },
    ]);
    expect(results.map((r) => r.source)).toEqual(["a/repo", "b/repo"]);
    expect(results[1]?.installs).toBe(15);
    expect(results[1]?.skills.map((s) => s.skillId)).toEqual(["x", "z"]);
    expect(results[1]?.skills.map((s) => s.installs)).toEqual([10, 5]);
  });

  test("source が取れない skill は結果に入れない", () => {
    expect(
      groupBySource([{ skillId: "x", name: "x", installs: 1 }, {}])
    ).toEqual([]);
  });

  test("installs が数値でなければ 0 として数える", () => {
    const results = groupBySource([
      { source: "a/repo", skillId: "x", name: "x" },
    ]);
    expect(results[0]?.installs).toBe(0);
  });
});
