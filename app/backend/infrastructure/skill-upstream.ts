import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  SkillRef,
  SkillUpstreamStatus,
  UpstreamVersion,
} from "../../shared/skill-workspace-types";
import { resolveCatalogPath } from "../domain/catalogPaths";
import { ValueError } from "../domain/errors";
import {
  assertSkillName,
  skillFilePath,
  SKILL_TEXT_LIMIT,
  writeSkillJson,
} from "../domain/skill-files";
import {
  frontmatterName,
  isInstallableSkillPath,
  uniqueExternalSkillCandidates,
} from "./github";

export type SkillSnapshot = {
  root: string;
  version: UpstreamVersion;
  ref: SkillRef;
};

class SkillUpstreamError extends ValueError {
  constructor(
    readonly state: "missing" | "unavailable" | "review",
    message: string
  ) {
    super(message);
    this.name = "SkillUpstreamError";
  }
}

type Entry = { mode: string; oid: string; size: number; path: string };
const run = promisify(execFile);
const pending = new Map<string, Promise<unknown>>();
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_FILE_SIZE = 8 * SKILL_TEXT_LIMIT;
const MAX_TOTAL_SIZE = 50 * SKILL_TEXT_LIMIT;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safePath(path: string): void {
  if (
    !path ||
    /[\\\x00-\x1f\x7f:]/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git"
      )
  )
    throw new ValueError("Source skill path must be a safe relative path");
}

function normalize(ref: SkillRef): SkillRef & { source: string } {
  assertSkillName(ref.name);
  if (
    typeof ref.source !== "string" ||
    ref.source.length > 200 ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(ref.source)
  )
    throw new ValueError("Source must be owner/repo");
  if (ref.skillPath !== undefined) {
    if (typeof ref.skillPath !== "string")
      throw new ValueError("Source skill path must be a string");
    safePath(ref.skillPath);
    if (ref.skillPath.split("/").at(-1) !== "SKILL.md")
      throw new ValueError("Source skill path must end in SKILL.md");
  }
  return { ...ref, source: ref.source.toLowerCase() };
}

function sourceDir(ref: SkillRef): string {
  return `.skill-loom/sources/${hash(ref.source!)}`;
}

function snapshotDir(ref: SkillRef, commit: string): string {
  return `${sourceDir(ref)}/snapshots/${commit}/${hash(ref.skillPath!)}`;
}

function pointerPath(ref: SkillRef): string {
  return resolveCatalogPath(`${sourceDir(ref)}/skills/${ref.name}.json`);
}

/** The pointer is published only after every blob is copied; no Git checkout is used. */
export function readCachedSkillSnapshot(input: SkillRef): SkillSnapshot | null {
  if (!input.source) return null;
  const ref = normalize(input);
  const path = pointerPath(ref);
  if (!existsSync(path)) return null;
  let saved: { ref: SkillRef; version: UpstreamVersion };
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
    const stored = normalize(saved.ref);
    if (
      stored.name !== ref.name ||
      stored.source !== ref.source ||
      !stored.skillPath ||
      !commitPattern.test(saved.version.commit) ||
      !Number.isFinite(Date.parse(saved.version.date))
    )
      throw new Error("Invalid snapshot metadata");
    if (ref.skillPath && ref.skillPath !== stored.skillPath)
      throw new Error(
        "Known source skill path changed; review tracking before switching paths"
      );
    const root = resolveCatalogPath(snapshotDir(stored, saved.version.commit));
    if (!existsSync(skillFilePath(root, "SKILL.md")))
      throw new Error("Cached SKILL.md is missing");
    return { root, version: saved.version, ref: stored };
  } catch (error) {
    throw new SkillUpstreamError(
      "review",
      error instanceof Error ? error.message : "Invalid snapshot metadata"
    );
  }
}

async function serialized<T>(
  ref: SkillRef,
  action: () => Promise<T>
): Promise<T> {
  const key = resolveCatalogPath(sourceDir(ref));
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}

async function git(repo: string, args: string[]): Promise<Buffer> {
  // Ignore inherited Git execution/config overrides; source blobs and hooks never run.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
  );
  const { stdout } = await run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "protocol.ext.allow=never",
      "-C",
      repo,
      ...args,
    ],
    {
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_LITERAL_PATHSPECS: "1",
      },
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: MAX_FILE_SIZE + 1024,
    }
  );
  return stdout;
}

function remote(ref: SkillRef): string {
  const mappingFile = process.env.MY_SKILLS_SOURCE_REPOS_FILE;
  if (!mappingFile) return `https://github.com/${ref.source}.git`;
  try {
    const mapping = JSON.parse(readFileSync(mappingFile, "utf8"));
    const path = Object.hasOwn(mapping, ref.source!)
      ? mapping[ref.source!]
      : undefined;
    if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path))
      throw new Error();
    return path;
  } catch {
    throw new SkillUpstreamError(
      "unavailable",
      "Configured source repository is unavailable"
    );
  }
}

function guardGitStorage(repo: string): void {
  for (const entry of readdirSync(repo, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new SkillUpstreamError(
        "review",
        "Git cache must not contain symlinks"
      );
    if (entry.isDirectory()) guardGitStorage(join(repo, entry.name));
  }
}

async function fetchHead(
  ref: SkillRef
): Promise<{ repo: string; version: UpstreamVersion; entries: Entry[] }> {
  const repo = resolveCatalogPath(`${sourceDir(ref)}/repo.git`);
  try {
    const url = remote(ref);
    if (!existsSync(repo)) {
      mkdirSync(repo, { recursive: true });
      await git(repo, ["init", "--bare", "--template="]);
    }
    guardGitStorage(repo);
    // No depth limit: scoped lag and ancestry require all reachable history.
    await git(repo, [
      "fetch",
      "--force",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      url,
      "HEAD",
    ]);
    const commit = (
      await git(repo, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
    )
      .toString()
      .trim();
    if (!commitPattern.test(commit)) throw new Error();
    const date = (await git(repo, ["show", "-s", "--format=%cI", commit]))
      .toString()
      .trim();
    const tree = (
      await git(repo, ["ls-tree", "-rlz", "--full-tree", commit])
    ).toString();
    const entries = tree
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match =
          /^(\d+) (?:blob|commit) ([a-f0-9]+) +([0-9]+|-)\t([\s\S]+)$/.exec(
            line
          );
        if (!match) throw new Error("Invalid Git tree");
        return {
          mode: match[1]!,
          oid: match[2]!,
          size: match[3] === "-" ? 0 : Number(match[3]),
          path: match[4]!,
        };
      });
    return { repo, version: { commit, date }, entries };
  } catch (error) {
    if (error instanceof SkillUpstreamError) throw error;
    throw new SkillUpstreamError(
      "unavailable",
      "Unable to check the source repository; retry later"
    );
  }
}

function regular(entry: Entry): void {
  try {
    safePath(entry.path);
  } catch {
    throw new SkillUpstreamError(
      "review",
      "Source skill contains an unsafe path"
    );
  }
  if (entry.mode !== "100644" && entry.mode !== "100755")
    throw new SkillUpstreamError(
      "review",
      "Source skill contains a symlink or submodule"
    );
  if (entry.size > MAX_FILE_SIZE)
    throw new SkillUpstreamError(
      "review",
      "Source skill exceeds the 8 MiB per-file limit"
    );
}

async function copyBlob(
  repo: string,
  entry: Entry,
  target: string
): Promise<void> {
  regular(entry);
  if (existsSync(target)) {
    const bytes = readFileSync(target);
    const oid = createHash(entry.oid.length === 40 ? "sha1" : "sha256")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (oid !== entry.oid)
      throw new SkillUpstreamError(
        "review",
        "Cached snapshot blob differs from its immutable source"
      );
    return;
  }
  const bytes = await git(repo, ["cat-file", "blob", entry.oid]);
  if (bytes.length !== entry.size)
    throw new SkillUpstreamError("review", "Source blob size changed");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, {
    flag: "wx",
    mode: entry.mode === "100755" ? 0o555 : 0o444,
  });
}

async function snapshot(ref: SkillRef): Promise<SkillSnapshot> {
  const cached = readCachedSkillSnapshot(ref);
  const pinned = cached?.ref.skillPath ?? ref.skillPath;
  const { repo, version, entries } = await fetchHead(ref);
  let skillPath = pinned;
  if (!skillPath) {
    const candidates: { name: string; path: string }[] = [];
    for (const entry of entries) {
      if (
        entry.path.split("/").at(-1) !== "SKILL.md" ||
        !isInstallableSkillPath(entry.path)
      )
        continue;
      regular(entry);
      const candidate = resolveCatalogPath(
        `${sourceDir(ref)}/discovery/${version.commit}/${hash(entry.path)}.md`
      );
      await copyBlob(repo, entry, candidate);
      candidates.push({ name: frontmatterName(candidate), path: entry.path });
    }
    skillPath = uniqueExternalSkillCandidates(candidates).find(
      (candidate) => candidate.name === ref.name
    )?.path;
  }
  if (!skillPath || !entries.some((entry) => entry.path === skillPath))
    throw new SkillUpstreamError(
      "missing",
      "The skill was not found at its source path"
    );
  const resolved = { ...ref, skillPath };
  const prefix = skillPath === "SKILL.md" ? "" : `${dirname(skillPath)}/`;
  const selected = entries.filter((entry) => entry.path.startsWith(prefix));
  if (
    selected.length > 2000 ||
    selected.reduce((sum, entry) => sum + entry.size, 0) > MAX_TOTAL_SIZE
  )
    throw new SkillUpstreamError(
      "review",
      "Source skill exceeds the 2000 file / 50 MiB limit"
    );
  for (const entry of selected) regular(entry);
  const root = resolveCatalogPath(snapshotDir(resolved, version.commit));
  for (const entry of selected) {
    const path = entry.path.slice(prefix.length);
    const target = skillFilePath(root, path);
    // Guard each target as well as the root, including pre-existing symlink ancestors.
    const guarded = resolveCatalogPath(
      `${snapshotDir(resolved, version.commit)}/${path}`
    );
    if (target !== guarded)
      throw new SkillUpstreamError(
        "review",
        "Snapshot path contains a symlink"
      );
    await copyBlob(repo, entry, guarded);
  }
  const pointer = pointerPath(ref);
  skillFilePath(dirname(pointer), `${ref.name}.json.tmp`);
  writeSkillJson(pointer, { ref: resolved, version });
  return { root, version, ref: resolved };
}

export async function fetchSkillSnapshot(
  input: SkillRef,
  refresh = false
): Promise<SkillSnapshot> {
  const ref = normalize(input);
  return serialized(ref, async () => {
    if (!refresh) {
      const cached = readCachedSkillSnapshot(ref);
      if (cached) return cached;
    }
    return snapshot(ref);
  });
}

export async function checkSkillUpstream(
  input: SkillRef,
  baseline?: UpstreamVersion,
  refresh = true
): Promise<SkillUpstreamStatus> {
  const ref = normalize(input);
  return serialized(ref, async () => {
    const checkedAt = new Date().toISOString();
    let latest: UpstreamVersion | undefined;
    try {
      latest = readCachedSkillSnapshot(ref)?.version;
      const fetched = refresh
        ? await snapshot(ref)
        : readCachedSkillSnapshot(ref);
      if (!fetched)
        return {
          state: "unknown",
          baseline,
          behind: null,
          checkedAt,
          message: "No cached upstream snapshot is available",
        };
      latest = fetched.version;
      if (!baseline || !commitPattern.test(baseline.commit))
        return {
          state: "unknown",
          baseline,
          latest,
          behind: null,
          checkedAt,
          message: "Baseline commit is unknown",
        };
      const repo = resolveCatalogPath(`${sourceDir(ref)}/repo.git`);
      try {
        await git(repo, [
          "rev-parse",
          "--verify",
          `${baseline.commit}^{commit}`,
        ]);
      } catch {
        return {
          state: "unknown",
          baseline,
          latest,
          behind: null,
          checkedAt,
          message: "Baseline commit cannot be resolved",
        };
      }
      try {
        await git(repo, [
          "merge-base",
          "--is-ancestor",
          baseline.commit,
          latest.commit,
        ]);
      } catch {
        return {
          state: "review",
          baseline,
          latest,
          behind: null,
          checkedAt,
          message: "Upstream history is no longer continuous with the baseline",
        };
      }
      const path = dirname(fetched.ref.skillPath!);
      const behind = Number(
        (
          await git(repo, [
            "rev-list",
            "--count",
            `${baseline.commit}..${latest.commit}`,
            "--",
            path,
          ])
        )
          .toString()
          .trim()
      );
      if (!Number.isSafeInteger(behind) || behind < 0)
        throw new Error("Invalid scoped commit count");
      return {
        state: behind > 0 ? "behind" : "current",
        baseline,
        latest,
        behind,
        checkedAt,
      };
    } catch (error) {
      if (error instanceof ValueError && !(error instanceof SkillUpstreamError))
        throw error;
      return {
        state:
          error instanceof SkillUpstreamError ? error.state : "unavailable",
        baseline,
        latest,
        behind: null,
        checkedAt,
        message:
          error instanceof SkillUpstreamError
            ? error.message
            : "Unable to check the source repository; retry later",
      };
    }
  });
}
