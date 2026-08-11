/**
 * lock / project deck の書き換えに付随する git commit。
 *
 * `bin/my-skills.py` の `commit_repo_changes` の移植。UI から skill を管理から外す
 * ような操作は、リポジトリのファイルを書き換えて初めて完了する。commit まで自動で
 * 済ませないと「UI では消えたのに次回 pull で戻る」が起きるため、ここが本体側の
 * 処理と同じタイミングで走ることに意味がある。
 *
 * 失敗しても例外にはしない。呼び出し側は成否を message の末尾に添えるだけで、
 * commit できなかったことを理由に skill の除外そのものを巻き戻したりはしない。
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { catalogRoot } from "../domain/config";

/** Python の `Path.resolve()` 相当。存在しないパスでも正規化だけはする。 */
function resolvePath(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(path);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

/** リポジトリ外のパスは黙って捨てる。git add に渡せないため。 */
export function repoRelativePaths(paths: Iterable<string>): string[] {
  const repoRoot = resolvePath(catalogRoot());
  const out: string[] = [];
  for (const path of paths) {
    const rel = relative(repoRoot, resolvePath(path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", catalogRoot(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * 指定パスを stage して commit し、message へ添える注記を返す。
 *
 * 戻り値が空文字なのは「何も commit しなかった」場合（自動 commit 無効、
 * リポジトリ外のパスだけ、git 管理下でない、差分なし）で、いずれも異常ではない。
 */
export function commitRepoChanges(
  message: string,
  paths: Iterable<string>
): string {
  if (process.env.MY_SKILLS_AUTO_COMMIT === "0") return "";
  const relativePaths = repoRelativePaths(paths);
  if (relativePaths.length === 0) return "";

  try {
    const inside = git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0)
      return " / git commit 失敗（手動でcommitしてください）";
    if (inside.stdout.trim() !== "true") return "";

    const added = git(["add", "--", ...relativePaths]);
    if (added.code !== 0)
      return " / git commit 失敗（手動でcommitしてください）";

    // `diff --cached --quiet` は差分が無いとき 0。stage されていなければ commit しない。
    if (git(["diff", "--cached", "--quiet"]).code === 0) return "";

    const commit = git(["commit", "-m", message]);
    if (commit.code !== 0) {
      const detail = (commit.stderr || commit.stdout || "")
        .trim()
        .split("\n")
        .filter(Boolean);
      const hint =
        detail.length > 0 ? detail[detail.length - 1] : "unknown git error";
      return ` / git commit 失敗（${hint}）`;
    }
    return " / git commit 済み";
  } catch {
    return " / git commit 失敗（手動でcommitしてください）";
  }
}
