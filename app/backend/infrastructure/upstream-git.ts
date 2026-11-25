/**
 * External Skill の上流 repo を blob なしで clone し、tree と commit だけで差分を読む。
 *
 * 一括更新の計画はここだけを通る。skills CLI も GitHub API も呼ばないので、
 * 計画が Projection や CLI lock を書き換えることは構造上起きない。
 */

import { spawn, spawnSync } from "node:child_process";

export type UpstreamFileChange = {
  status: string;
  path: string;
  mode: string;
};

const CLONE_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;
const ALLOWED_URL = /^(https:\/\/|file:\/\/\/)/;

/** 呼び出し元の hook などが設定した repo 指定を外す。残ると clone 先ではなく呼び出し元の repo を読む。 */
const REPO_SCOPED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    GIT_ALLOW_PROTOCOL: "https:ssh:file",
  };
  for (const key of REPO_SCOPED_GIT_ENV) delete env[key];
  return env;
}

type GitResult = { code: number; stdout: string; stderr: string };

function runGit(args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { env: gitEnv(), timeout });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      resolve({ code: -1, stdout: "", stderr: error.message })
    );
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })
    );
  });
}

class UpstreamGitError extends Error {}

function parseRawDiff(output: string, prefix: string): UpstreamFileChange[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const changes: UpstreamFileChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, , , status] = (fields[index] ?? "")
      .replace(/^:/, "")
      .split(" ");
    const path = fields[index + 1] ?? "";
    changes.push({
      status: status ?? "",
      path: prefix ? `${prefix}/${path}` : path,
      mode: status === "D" ? (oldMode ?? "") : (newMode ?? ""),
    });
  }
  return changes;
}

export class UpstreamClone {
  private constructor(readonly dir: string) {}

  static async clone(url: string, dir: string): Promise<UpstreamClone> {
    if (!ALLOWED_URL.test(url))
      throw new UpstreamGitError(`unsupported source URL: ${url}`);
    const result = await runGit(
      [
        "clone",
        "--quiet",
        "--filter=blob:none",
        "--no-checkout",
        "--",
        url,
        dir,
      ],
      CLONE_TIMEOUT_MS
    );
    if (result.code !== 0)
      throw new UpstreamGitError(
        `git clone failed: ${result.stderr.trim() || url}`
      );
    return new UpstreamClone(dir);
  }

  private git(args: string[]): Promise<GitResult> {
    return runGit(["-C", this.dir, ...args]);
  }

  async head(): Promise<string> {
    const result = await this.git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (result.code !== 0)
      throw new UpstreamGitError(
        `cannot resolve HEAD: ${result.stderr.trim()}`
      );
    return result.stdout.trim();
  }

  /** commit の中の folder の tree SHA。commit が無い・folder が無いときは null。 */
  async treeOf(commit: string, folder: string): Promise<string | null> {
    const result = await this.git([
      "rev-parse",
      "--verify",
      "--quiet",
      `${commit}:${folder}`,
    ]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async hasTree(sha: string): Promise<boolean> {
    const result = await this.git(["cat-file", "-t", sha]);
    return result.code === 0 && result.stdout.trim() === "tree";
  }

  async hasCommit(sha: string): Promise<boolean> {
    const result = await this.git(["cat-file", "-t", sha]);
    return result.code === 0 && result.stdout.trim() === "commit";
  }

  /** 2 つの tree の差分。path は folder を前に付けて repo からの相対にする。 */
  async diffTrees(
    base: string,
    head: string,
    folder: string
  ): Promise<UpstreamFileChange[]> {
    const result = await this.git([
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      base,
      head,
    ]);
    if (result.code !== 0)
      throw new UpstreamGitError(`git diff-tree failed: ${result.stderr}`);
    return parseRawDiff(result.stdout, folder);
  }

  async commitCount(from: string, to: string, folder: string): Promise<number> {
    const result = await this.git([
      "rev-list",
      "--count",
      `${from}..${to}`,
      "--",
      folder,
    ]);
    if (result.code !== 0)
      throw new UpstreamGitError(`git rev-list failed: ${result.stderr}`);
    return Number.parseInt(result.stdout.trim(), 10);
  }

  /** blob を 1 つ読む。blob なし clone なので、ここで初めて取得が走る。 */
  readBlob(commit: string, path: string): Uint8Array | null {
    const result = spawnSync(
      "git",
      ["-C", this.dir, "cat-file", "blob", `${commit}:${path}`],
      { env: gitEnv(), timeout: GIT_TIMEOUT_MS }
    );
    return result.status === 0 ? new Uint8Array(result.stdout) : null;
  }
}
