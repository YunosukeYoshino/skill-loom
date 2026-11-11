import { expect, test } from "bun:test";
import { codeLanguage, diffLines } from "./code-language";

test("拡張子から編集時のハイライト言語を選び、未対応はハイライトなしにする", () => {
  expect(codeLanguage("SKILL.md")).toBe("markdown");
  expect(codeLanguage("references/Guide.MD")).toBe("markdown");
  expect(codeLanguage("config.yml")).toBe("yaml");
  expect(codeLanguage("data/schema.json")).toBe("json");
  expect(codeLanguage("scripts/run.py")).toBe("python");
  expect(codeLanguage("scripts/run.sh")).toBe("shell");
  expect(codeLanguage("lib/index.mjs")).toBe("javascript");
  expect(codeLanguage("lib/view.tsx")).toBe("typescript");
  expect(codeLanguage("notes.txt")).toBeNull();
  expect(codeLanguage("Makefile")).toBeNull();
  expect(codeLanguage(".env")).toBeNull();
  expect(codeLanguage("dir.md/LICENSE")).toBeNull();
});

test("git diff をヘッダーとハンク内の追加・削除・文脈に分類する", () => {
  const diff = [
    "diff --git a/SKILL.md b/SKILL.md",
    "index 1234..5678 100644",
    "--- a/SKILL.md",
    "+++ b/SKILL.md",
    "@@ -1,3 +1,3 @@ heading",
    "----",
    "+---",
    "--- removed list item",
    "+++ added text",
    " unchanged",
    "diff --git a/new.md b/new.md",
    "new file mode 100644",
    "\\ No newline at end of file",
    "[Diff truncated at 1 MiB]",
  ].join("\n");
  expect(diffLines(diff).map((line) => line.kind)).toEqual([
    "meta",
    "meta",
    "meta",
    "meta",
    "hunk",
    "removed",
    "added",
    "removed",
    "added",
    "context",
    "meta",
    "meta",
    "meta",
    "meta",
  ]);
  expect(diffLines(diff)[5]?.text).toBe("----");
  expect(diffLines("")).toEqual([]);
});
