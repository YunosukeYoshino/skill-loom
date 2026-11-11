export type CodeLanguage =
  | "markdown"
  | "yaml"
  | "json"
  | "python"
  | "shell"
  | "javascript"
  | "typescript";

const byExtension: Record<string, CodeLanguage> = {
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
};

export function codeLanguage(path: string): CodeLanguage | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return byExtension[name.slice(dot + 1).toLowerCase()] ?? null;
}

export type DiffLine = {
  kind: "added" | "removed" | "hunk" | "meta" | "context";
  text: string;
};

// `--- ` / `+++ ` はハンク外ならファイル見出し、ハンク内なら削除・追加行。
export function diffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  let inHunk = false;
  return diff.split("\n").map((text) => {
    if (text.startsWith("diff ")) inHunk = false;
    if (text.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text };
    }
    if (!inHunk || text.startsWith("\\") || text.startsWith("[Diff truncated"))
      return { kind: "meta", text };
    if (text.startsWith("+")) return { kind: "added", text };
    if (text.startsWith("-")) return { kind: "removed", text };
    return { kind: "context", text };
  });
}
