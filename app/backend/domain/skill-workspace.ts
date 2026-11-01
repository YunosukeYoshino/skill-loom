import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  SkillRef,
  SkillUpstreamStatus,
  SkillVersion,
  SkillView,
  UpstreamVersion,
} from "../../shared/skill-workspace-types";
import {
  checkSkillUpstream,
  fetchSkillSnapshot,
  readCachedSkillSnapshot,
} from "../infrastructure/skill-upstream";
import { resolveCatalogPath } from "./catalogPaths";
import { activeDir, archiveDir } from "./config";
import { customSkillRepoDir } from "./custom";
import { draftSkillMap } from "./drafts";
import { ValueError } from "./errors";
import { loadLock } from "./inventory";
import { trashPath } from "./projection";
import {
  assertSkillName,
  copySkillTree,
  listSkillFiles,
  SKILL_TEXT_LIMIT,
  skillFilePath,
  skillTreeHash,
  writeSkillJson,
} from "./skill-files";

export type SkillWorkspace = {
  ref: SkillRef;
  fingerprint: string;
  baseline?: UpstreamVersion;
  pending?: UpstreamVersion;
  conflicts: string[];
};

export class SkillWorkspaceConflict extends ValueError {}

type Tracking = {
  ref: SkillRef;
  baseline?: UpstreamVersion;
  status?: SkillUpstreamStatus;
};
type SourceSnapshot = { ref: SkillRef; version: UpstreamVersion };

function checkedRef(ref: SkillRef): SkillRef {
  if (!ref || typeof ref !== "object")
    throw new ValueError("Invalid skill reference");
  assertSkillName(ref.name);
  if (
    ref.source !== undefined &&
    (typeof ref.source !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(ref.source))
  )
    throw new ValueError("Source must be owner/repo");
  if (
    ref.skillPath !== undefined &&
    (typeof ref.skillPath !== "string" ||
      /[\\\x00-\x1f\x7f:]/.test(ref.skillPath) ||
      ref.skillPath
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git"
        ) ||
      ref.skillPath.split("/").at(-1) !== "SKILL.md")
  )
    throw new ValueError("Invalid source skill path");
  return {
    name: ref.name,
    ...(ref.source ? { source: ref.source.toLowerCase() } : {}),
    ...(ref.skillPath ? { skillPath: ref.skillPath } : {}),
  };
}

function checkedVersion(version: UpstreamVersion | undefined): void {
  if (
    version !== undefined &&
    (!version ||
      typeof version !== "object" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(version.commit) ||
      typeof version.date !== "string" ||
      !Number.isFinite(Date.parse(version.date)))
  )
    throw new ValueError("Invalid upstream version metadata");
}

function assertSameRef(stored: SkillRef, requested: SkillRef): void {
  if (
    stored.name !== requested.name ||
    (requested.source && stored.source !== requested.source) ||
    (requested.skillPath &&
      stored.skillPath &&
      stored.skillPath !== requested.skillPath)
  )
    throw new SkillWorkspaceConflict(
      "A different source or skill path owns this saved state"
    );
}

function readState<T>(path: string): T | undefined {
  const file = skillStatePath(path);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new ValueError("Invalid saved skill metadata");
  }
}

function writeState(path: string, value: unknown): void {
  const file = skillStatePath(path);
  skillFilePath(dirname(file), `${basename(file)}.tmp`);
  writeSkillJson(file, value);
}

function readTracking(ref: SkillRef): Tracking | undefined {
  const data = readState<Tracking>(`tracking/${ref.name}.json`);
  if (!data) return undefined;
  data.ref = checkedRef(data.ref);
  assertSameRef(data.ref, ref);
  checkedVersion(data.baseline);
  if (data.status !== undefined) {
    const status = data.status;
    if (
      !status ||
      ![
        "unchecked",
        "current",
        "behind",
        "missing",
        "unavailable",
        "review",
        "unknown",
      ].includes(status.state) ||
      !(
        status.behind === null ||
        (Number.isSafeInteger(status.behind) && status.behind >= 0)
      ) ||
      (status.checkedAt !== undefined &&
        !Number.isFinite(Date.parse(status.checkedAt))) ||
      ("attemptedAt" in status &&
        status.attemptedAt !== undefined &&
        (typeof status.attemptedAt !== "string" ||
          !Number.isFinite(Date.parse(status.attemptedAt))))
    )
      throw new ValueError("Invalid upstream status metadata");
    checkedVersion(status.baseline);
    checkedVersion(status.latest);
  }
  return data;
}

function readSourceSnapshot(ref: SkillRef): SourceSnapshot | undefined {
  const saved = readState<SourceSnapshot>(
    `source-snapshots/${ref.name}/snapshot.json`
  );
  if (!saved) return undefined;
  saved.ref = checkedRef(saved.ref);
  assertSameRef(saved.ref, ref);
  if (!saved.ref.source || !saved.ref.skillPath || !saved.version)
    throw new ValueError("Invalid source snapshot metadata");
  checkedVersion(saved.version);
  if (
    !existsSync(skillStatePath(`source-snapshots/${ref.name}/files/SKILL.md`))
  )
    throw new ValueError("Saved source snapshot is missing");
  return saved;
}

function atomicSkillWrite(
  root: string,
  path: string,
  bytes: string | Buffer,
  mode = 0o644
): void {
  const file = skillFilePath(root, path);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = skillFilePath(root, `${path}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  renameSync(temporary, file);
}

export function requireWorkspace(ref: SkillRef): SkillWorkspace {
  ref = checkedRef(ref);
  const workspace = loadSkillWorkspace(ref.name);
  if (!workspace) throw new ValueError("Fork this skill before editing");
  assertSameRef(workspace.ref, ref);
  return workspace;
}

export async function saveSkillFile(
  ref: SkillRef,
  path: string,
  content: string,
  revision: string
): Promise<SkillView> {
  const workspace = requireWorkspace(ref);
  const root = join(workspaceRoot(ref.name), "files");
  if (typeof revision !== "string" || revision !== skillTreeHash(root))
    throw new SkillWorkspaceConflict(
      "The working copy has changed; reload before saving"
    );
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > SKILL_TEXT_LIMIT
  )
    throw new ValueError("Text exceeds the 1 MiB edit limit");
  const file = skillFilePath(root, path);
  atomicSkillWrite(
    root,
    path,
    content,
    existsSync(file) ? lstatSync(file).mode & 0o777 : 0o644
  );
  workspace.conflicts = workspace.conflicts.filter((item) => item !== path);
  writeState(`workspaces/${ref.name}/workspace.json`, workspace);
  return viewSkill(workspace.ref, "work", path);
}

function treeDiff(before: string, after: string): string {
  listSkillFiles(before);
  listSkillFiles(after);
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      before,
      after,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new Error("Could not compare working copy");
  const text = result.stdout.toString();
  return text.length > SKILL_TEXT_LIMIT
    ? `${text.slice(0, SKILL_TEXT_LIMIT)}\n[Diff truncated at 1 MiB]`
    : text;
}

export function skillStatePath(path: string): string {
  const root = resolveCatalogPath(".skill-loom");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = skillFilePath(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n", { flag: "wx" });
  return resolveCatalogPath(`.skill-loom/${path}`);
}

export function workspaceRoot(name: string): string {
  assertSkillName(name);
  const root = skillStatePath(`workspaces/${name}`);
  for (const path of [
    "files",
    "original",
    "baseline",
    "pending-upstream",
    "conflict-work",
    "conflict-incoming",
    "workspace.json",
  ])
    skillFilePath(root, path);
  return root;
}

function loadSkillWorkspace(name: string): SkillWorkspace | undefined {
  assertSkillName(name);
  workspaceRoot(name);
  const data = readState<SkillWorkspace>(`workspaces/${name}/workspace.json`);
  if (!data) return undefined;
  data.ref = checkedRef(data.ref);
  if (
    data.ref.name !== name ||
    !Array.isArray(data.conflicts) ||
    typeof data.fingerprint !== "string"
  )
    throw new ValueError("Invalid workspace metadata");
  for (const path of data.conflicts) {
    if (typeof path !== "string")
      throw new ValueError("Invalid workspace conflict metadata");
    skillFilePath(join(workspaceRoot(name), "files"), path);
  }
  checkedVersion(data.baseline);
  checkedVersion(data.pending);
  return data;
}

function resolveLocalSkill(ref: SkillRef): {
  ref: SkillRef;
  kind: SkillView["kind"];
  root?: string;
} {
  ref = checkedRef(ref);
  const lock = loadLock();
  const meta = lock.vendor?.[ref.name] ?? lock.external?.[ref.name];
  let resolved = checkedRef({
    ...ref,
    source: ref.source ?? meta?.source,
    skillPath: ref.skillPath ?? meta?.skillPath,
  });
  if (ref.source && meta?.source && ref.source !== meta.source.toLowerCase())
    throw new SkillWorkspaceConflict("A different source owns this skill");
  const tracking = readTracking(resolved);
  if (tracking)
    resolved = checkedRef({
      ...tracking.ref,
      ...resolved,
      skillPath: resolved.skillPath ?? tracking.ref.skillPath,
    });
  if (lock.custom?.skills?.[ref.name])
    return {
      ref: resolved,
      kind: "custom",
      root: customSkillRepoDir(lock, ref.name) ?? undefined,
    };
  if (lock.vendor?.[ref.name])
    return {
      ref: resolved,
      kind: "vendor",
      root: resolveCatalogPath(`vendor/${ref.name}`),
    };
  if (lock.external?.[ref.name]) {
    const repoPath = lock.external[ref.name]?.localRepoPath;
    const catalog = repoPath ? resolveCatalogPath(repoPath) : undefined;
    const saved = readSourceSnapshot(resolved);
    return {
      ref: saved?.ref ?? resolved,
      kind: "external",
      root:
        catalog && existsSync(catalog)
          ? catalog
          : (installedSkillRoot(ref.name) ??
            (saved
              ? skillStatePath(`source-snapshots/${ref.name}/files`)
              : undefined)),
    };
  }
  const draft = draftSkillMap().get(ref.name);
  if (draft)
    return {
      ref: resolved,
      kind: "draft",
      root: resolveCatalogPath(draft.repoPath),
    };
  const saved = readSourceSnapshot(resolved);
  return {
    ref: saved?.ref ?? resolved,
    kind: resolved.source ? "external" : "untracked",
    root:
      (resolved.source ? undefined : installedSkillRoot(ref.name)) ??
      (saved
        ? skillStatePath(`source-snapshots/${ref.name}/files`)
        : undefined),
  };
}

async function resolveSkill(
  ref: SkillRef
): Promise<ReturnType<typeof resolveLocalSkill>> {
  const local = resolveLocalSkill(ref);
  if (
    (local.root && existsSync(local.root)) ||
    !local.ref.source ||
    local.kind === "vendor"
  )
    return local;
  const fetched = await fetchSkillSnapshot(local.ref);
  const root = skillStatePath(`source-snapshots/${ref.name}/files`);
  if (existsSync(root)) trashPath(root);
  copySkillTree(fetched.root, root);
  writeState(`source-snapshots/${ref.name}/snapshot.json`, {
    ref: fetched.ref,
    version: fetched.version,
  });
  const tracking = readTracking(fetched.ref);
  const lock = loadLock();
  const baseline =
    tracking?.baseline ??
    (!lock.external?.[ref.name] && !lock.vendor?.[ref.name]
      ? fetched.version
      : undefined);
  writeState(`tracking/${ref.name}.json`, {
    ...tracking,
    ref: fetched.ref,
    baseline,
  });
  return { ...local, ref: fetched.ref, root };
}

function baselineRoot(
  ref: SkillRef,
  workspace?: SkillWorkspace
): string | undefined {
  const working = join(workspaceRoot(ref.name), "baseline");
  if (workspace && existsSync(working)) return working;
  const upstream = resolveCatalogPath(`upstream/${ref.name}`);
  if (existsSync(upstream)) return upstream;
  const saved = readSourceSnapshot(ref);
  const baseline = workspace?.baseline ?? readTracking(ref)?.baseline;
  if (saved && saved.version.commit === baseline?.commit)
    return skillStatePath(`source-snapshots/${ref.name}/files`);
  return undefined;
}

export function sourceFingerprint(ref: SkillRef): string {
  const local = resolveLocalSkill(ref);
  const lock = loadLock();
  return JSON.stringify({
    custom: lock.custom?.skills?.[ref.name],
    external: lock.external?.[ref.name],
    vendor: lock.vendor?.[ref.name],
    content: local.root ? skillTreeHash(local.root) : "missing",
    installed: installedSkillRoot(ref.name)
      ? skillTreeHash(installedSkillRoot(ref.name)!)
      : "missing",
  });
}

export function validateSkillWorkspace(name: string): string[] {
  const root = join(workspaceRoot(name), "files");
  const issues: string[] = [];
  try {
    listSkillFiles(root);
    const text = readFileSync(skillFilePath(root, "SKILL.md"), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) return ["YAML frontmatter is required"];
    const meta = Bun.YAML.parse(match[1]!) as Record<string, unknown>;
    if (!meta || typeof meta !== "object" || meta.name !== name)
      issues.push("YAML name must match the skill name");
    if (
      !meta ||
      typeof meta.description !== "string" ||
      !meta.description.trim()
    )
      issues.push("YAML description must be a non-empty string");
    for (const file of listSkillFiles(root)) {
      if (
        !file.binary &&
        file.size <= SKILL_TEXT_LIMIT &&
        /^(?:<<<<<<<|>>>>>>>)(?: |$)/m.test(
          readFileSync(skillFilePath(root, file.path), "utf8")
        )
      )
        issues.push(`Unresolved merge conflict: ${file.path}`);
    }
  } catch (error) {
    issues.push(
      `YAML / file validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return issues;
}

export async function forkSkill(ref: SkillRef): Promise<SkillView> {
  ref = checkedRef(ref);
  const existing = loadSkillWorkspace(ref.name);
  if (existing) {
    assertSameRef(existing.ref, ref);
    return viewSkill(existing.ref, "work");
  }
  const local = await resolveSkill(ref);
  if (local.kind === "custom" || local.kind === "draft")
    throw new ValueError(
      "Authored skills can be viewed but are not external forks"
    );
  if (!local.ref.source || !local.root)
    throw new ValueError("External skill source is required to fork");
  const root = workspaceRoot(ref.name);
  if (existsSync(root))
    throw new SkillWorkspaceConflict(
      "An incomplete workspace needs review before restarting"
    );
  copySkillTree(local.root, join(root, "original"));
  copySkillTree(local.root, join(root, "files"));
  const baseline = readTracking(local.ref)?.baseline;
  const base = baselineRoot(local.ref);
  if (base) copySkillTree(base, join(root, "baseline"));
  writeState(`workspaces/${ref.name}/workspace.json`, {
    ref: local.ref,
    fingerprint: sourceFingerprint(local.ref),
    baseline,
    conflicts: [],
  } satisfies SkillWorkspace);
  return viewSkill(local.ref, "work");
}

function installedSkillRoot(name: string): string | undefined {
  assertSkillName(name);
  return [activeDir(), archiveDir()]
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
}

export async function viewSkill(
  ref: SkillRef,
  version: SkillVersion = "source",
  file = "SKILL.md"
): Promise<SkillView> {
  ref = checkedRef(ref);
  if (
    !["source", "upstream", "work", "installed", "baseline"].includes(version)
  )
    throw new ValueError("Version is not available");
  const workspace = loadSkillWorkspace(ref.name);
  if (workspace) assertSameRef(workspace.ref, ref);
  const local =
    version === "work" && workspace
      ? resolveLocalSkill(workspace.ref)
      : await resolveSkill(ref);
  let { root } = local;
  const { kind } = local;
  const installed = installedSkillRoot(ref.name);
  const tracking = readTracking(local.ref);
  const baseline = baselineRoot(local.ref, workspace);
  const cached = local.ref.source ? readCachedSkillSnapshot(local.ref) : null;
  const versions: SkillVersion[] = [
    "source",
    ...(cached ? ["upstream" as const] : []),
    ...(baseline ? ["baseline" as const] : []),
    ...(workspace ? ["work" as const] : []),
    ...(installed ? ["installed" as const] : []),
  ];
  if (version === "installed") root = installed;
  else if (version === "work" && workspace)
    root = join(workspaceRoot(ref.name), "files");
  else if (version === "upstream") root = cached?.root;
  else if (version === "baseline") root = baseline;
  else if (version !== "source")
    throw new ValueError("Version is not available");
  if (!root || !existsSync(root))
    throw new ValueError("Skill source is not available");
  const files = listSkillFiles(root);
  const selected = files.find((row) => row.path === file);
  skillFilePath(root, file);
  if (!selected) throw new ValueError("Skill file not found");
  const data = selected.binary
    ? null
    : readFileSync(skillFilePath(root, file)).subarray(0, SKILL_TEXT_LIMIT);
  const content = data?.toString("utf8") ?? null;
  const baseChanged = workspace
    ? workspace.fingerprint !== sourceFingerprint(workspace.ref)
    : false;
  const recovery = existsSync(
    skillStatePath(`transactions/${ref.name}/journal.json`)
  );
  const upstream = tracking?.status ?? {
    state: "unchecked" as const,
    baseline: tracking?.baseline ?? workspace?.baseline,
    behind: null,
  };
  const comparison =
    version === "baseline"
      ? undefined
      : (baseline ??
        (workspace && version === "work"
          ? join(workspaceRoot(ref.name), "original")
          : undefined));
  const knownBaseline = tracking?.baseline ?? workspace?.baseline;
  const diff =
    version === "upstream" && !knownBaseline
      ? "Comparison unavailable: baseline unknown"
      : version === "upstream" && !baseline
        ? "Comparison unavailable: baseline snapshot unavailable"
        : comparison
          ? `${knownBaseline ? "" : "Comparison against retained source snapshot (upstream baseline unknown)\n"}${treeDiff(comparison, root)}`
          : "";
  const message = recovery
    ? "適用の復旧が必要です。復旧後に作業を再開してください。"
    : baseChanged
      ? "正本が別の操作で変更されています。版を比較し、正本を再調整して作業内容と統合してください。"
      : undefined;
  return {
    ref: local.ref,
    kind,
    version,
    versions,
    files,
    selectedFile: file,
    content,
    html:
      content !== null && /\.md$/i.test(file)
        ? Bun.markdown.html(content)
        : null,
    binary: selected.binary,
    truncated: selected.size > SKILL_TEXT_LIMIT,
    revision: skillTreeHash(root),
    diff,
    upstream,
    ...(message ? { message } : {}),
    ...(workspace
      ? {
          workspace: {
            dirty:
              skillTreeHash(join(workspaceRoot(ref.name), "files")) !==
              skillTreeHash(join(workspaceRoot(ref.name), "original")),
            conflicts: workspace.conflicts,
            issues: validateSkillWorkspace(ref.name),
            baseChanged,
          },
        }
      : {}),
  };
}

export async function checkSkillUpdates(ref: SkillRef): Promise<SkillView> {
  const local = await resolveSkill(checkedRef(ref));
  if (!local.ref.source)
    throw new ValueError("External skill source is required");
  const workspace = loadSkillWorkspace(ref.name);
  if (workspace) assertSameRef(workspace.ref, local.ref);
  const tracking = readTracking(local.ref);
  const baseline = tracking?.baseline ?? workspace?.baseline;
  const previousLatest =
    tracking?.status?.latest ?? readCachedSkillSnapshot(local.ref)?.version;
  const checked = await checkSkillUpstream(local.ref, baseline);
  const failed = ["missing", "unavailable", "review"].includes(checked.state);
  const status = {
    ...checked,
    attemptedAt: checked.checkedAt,
    checkedAt: failed ? tracking?.status?.checkedAt : checked.checkedAt,
    latest: failed ? (previousLatest ?? checked.latest) : checked.latest,
  };
  const cached = readCachedSkillSnapshot(local.ref);
  const resolved = cached?.ref ?? local.ref;
  writeState(`tracking/${ref.name}.json`, {
    ref: resolved,
    baseline,
    status,
  } satisfies Tracking);
  return viewSkill(resolved, workspace ? "work" : "source");
}

function sameBytes(
  left: Buffer | undefined,
  right: Buffer | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.equals(right);
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function mergeText(
  work: string,
  base: string,
  incoming: string
): { bytes: Buffer; conflict: boolean } | undefined {
  try {
    const bytes = execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "merge-file",
        "--stdout",
        "--diff3",
        "-L",
        "work",
        "-L",
        "baseline",
        "-L",
        "upstream",
        "--",
        work,
        base,
        incoming,
      ],
      {
        timeout: 10_000,
        maxBuffer: 50 * SKILL_TEXT_LIMIT,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }
    );
    return { bytes, conflict: false };
  } catch (error) {
    const result = error as { status?: number; stdout?: Buffer };
    if (
      result.status !== undefined &&
      result.status > 0 &&
      result.status <= 127 &&
      Buffer.isBuffer(result.stdout)
    )
      return { bytes: result.stdout, conflict: true };
    throw new ValueError(
      "Unable to merge upstream text; the working copy was preserved"
    );
  }
}

export async function mergeSkillUpdates(ref: SkillRef): Promise<SkillView> {
  ref = checkedRef(ref);
  const workspace = requireWorkspace(ref);
  if (workspace.conflicts.length)
    throw new SkillWorkspaceConflict(
      "Resolve existing merge conflicts before fetching another update"
    );
  if (workspace.fingerprint !== sourceFingerprint(workspace.ref))
    throw new SkillWorkspaceConflict(
      "The source has changed; compare versions or discard and restart the fork"
    );
  const root = workspaceRoot(ref.name);
  const work = join(root, "files");
  const revision = skillTreeHash(work);
  const metadata = readFileSync(
    skillStatePath(`workspaces/${ref.name}/workspace.json`),
    "utf8"
  );
  const checked = await checkSkillUpdates(workspace.ref);
  if (["missing", "unavailable", "review"].includes(checked.upstream.state))
    throw new SkillWorkspaceConflict(
      checked.upstream.message ?? "Upstream needs review before merging"
    );
  const latest = readCachedSkillSnapshot(workspace.ref);
  if (!latest) throw new ValueError("Upstream snapshot is not available");
  let base = workspace.pending
    ? join(root, "pending-upstream")
    : baselineRoot(workspace.ref, workspace);
  const baseVersion = workspace.pending ?? workspace.baseline;
  if (workspace.pending) {
    const status = await checkSkillUpstream(
      workspace.ref,
      workspace.pending,
      false
    );
    if (
      status.state === "review" ||
      status.state === "missing" ||
      status.state === "unavailable"
    )
      throw new SkillWorkspaceConflict(
        status.message ?? "Pending upstream needs review"
      );
    if (status.state === "unknown") base = undefined;
  }
  if (
    !baseVersion ||
    checked.upstream.state === "unknown" ||
    !base ||
    !existsSync(base)
  )
    base = undefined;
  mergeWorkspaceCopies(
    workspace,
    latest.root,
    base,
    { pending: latest.version },
    {
      revision,
      metadata,
      fingerprint: workspace.fingerprint,
    }
  );
  const result = await viewSkill(workspace.ref, "work");
  return base
    ? result
    : {
        ...result,
        message:
          "基準版が不明です。作業内容は保持しています。上流との差を比較し、各ファイルを保存して解決してください。",
      };
}

function mergeWorkspaceCopies(
  workspace: SkillWorkspace,
  incoming: string,
  base: string | undefined,
  change: { pending: UpstreamVersion } | { fingerprint: string },
  review: { revision: string; metadata: string; fingerprint: string }
): void {
  const name = workspace.ref.name;
  const root = workspaceRoot(name);
  const work = join(root, "files");
  const stage = skillStatePath(`workspaces/${name}/merge-${randomUUID()}`);
  const stagedWork = join(stage, "files");
  const incomingKey = "pending" in change ? "pending-upstream" : "original";
  copySkillTree(work, stagedWork);
  copySkillTree(work, join(stage, "conflict-work"));
  copySkillTree(incoming, join(stage, "conflict-incoming"));
  copySkillTree(incoming, join(stage, incomingKey));
  let preserveStage = false;
  const paths = new Set(
    [
      ...listSkillFiles(work),
      ...listSkillFiles(incoming),
      ...(base ? listSkillFiles(base) : []),
    ].map((file) => file.path)
  );
  const conflicts: string[] = [];
  try {
    for (const path of [...paths].sort()) {
      const read = (dir: string | undefined): Buffer | undefined =>
        dir &&
        existsSync(skillFilePath(dir, path)) &&
        lstatSync(skillFilePath(dir, path)).isFile()
          ? readFileSync(skillFilePath(dir, path))
          : undefined;
      const ours = read(work);
      const theirs = read(incoming);
      const original = read(base);
      const mode = (dir: string | undefined, bytes: Buffer | undefined) =>
        bytes && dir
          ? lstatSync(skillFilePath(dir, path)).mode & 0o111
          : undefined;
      const oursMode = mode(work, ours);
      const theirsMode = mode(incoming, theirs);
      const originalMode = mode(base, original);
      if (sameBytes(ours, theirs) && oursMode === theirsMode) continue;
      if (!base) {
        conflicts.push(path);
        continue;
      }
      if (sameBytes(theirs, original) && theirsMode === originalMode) continue;
      if (sameBytes(ours, original) && oursMode === originalMode) {
        let ancestor = skillFilePath(stagedWork, path);
        let obstruction =
          existsSync(ancestor) && lstatSync(ancestor).isDirectory();
        while (dirname(ancestor) !== stagedWork) {
          ancestor = dirname(ancestor);
          if (existsSync(ancestor) && !lstatSync(ancestor).isDirectory())
            obstruction = true;
        }
        if (theirs && obstruction) {
          conflicts.push(path);
          continue;
        }
        if (theirs)
          atomicSkillWrite(
            stagedWork,
            path,
            theirs,
            (lstatSync(skillFilePath(incoming, path)).mode & 0o777) | 0o600
          );
        else trashPath(skillFilePath(stagedWork, path));
        continue;
      }
      if (
        ours &&
        original &&
        theirs &&
        isText(ours) &&
        isText(original) &&
        isText(theirs)
      ) {
        const merged = mergeText(
          skillFilePath(work, path),
          skillFilePath(base, path),
          skillFilePath(incoming, path)
        );
        if (merged) {
          atomicSkillWrite(
            stagedWork,
            path,
            merged.bytes,
            ((oursMode === originalMode ? theirsMode : oursMode) ?? 0) | 0o644
          );
          if (merged.conflict) conflicts.push(path);
          continue;
        }
      }
      conflicts.push(path);
    }
    listSkillFiles(stagedWork);
    if (
      review.revision !== skillTreeHash(work) ||
      review.metadata !==
        readFileSync(
          skillStatePath(`workspaces/${name}/workspace.json`),
          "utf8"
        ) ||
      review.fingerprint !== sourceFingerprint(workspace.ref)
    )
      throw new SkillWorkspaceConflict(
        "The working copy or source changed during the merge; review and retry"
      );
    const replaced: string[] = [];
    const installed: string[] = [];
    preserveStage = true;
    try {
      for (const key of [
        "files",
        "conflict-work",
        "conflict-incoming",
        incomingKey,
      ]) {
        const target = join(root, key);
        if (existsSync(target)) {
          renameSync(target, join(stage, `previous-${key}`));
          replaced.push(key);
        }
        renameSync(join(stage, key), target);
        installed.push(key);
      }
      writeState(`workspaces/${name}/workspace.json`, {
        ...workspace,
        ...change,
        conflicts,
      });
    } catch (error) {
      try {
        for (const key of installed.reverse()) trashPath(join(root, key));
        for (const key of replaced.reverse())
          renameSync(join(stage, `previous-${key}`), join(root, key));
        preserveStage = false;
      } catch (recovery) {
        throw new Error(
          `Workspace merge recovery is required; backups retained at ${stage}: ${String(error)} / ${String(recovery)}`
        );
      }
      throw error;
    }
    preserveStage = false;
  } catch (error) {
    if (!preserveStage) trashPath(stage);
    throw error;
  }
  trashPath(stage);
}

export async function reconcileSkillSource(
  ref: SkillRef,
  revision: string
): Promise<SkillView> {
  ref = checkedRef(ref);
  const workspace = requireWorkspace(ref);
  const root = workspaceRoot(ref.name);
  const work = join(root, "files");
  if (typeof revision !== "string" || revision !== skillTreeHash(work))
    throw new SkillWorkspaceConflict(
      "The working copy changed; review it before reconciling the source"
    );
  if (workspace.conflicts.length)
    throw new SkillWorkspaceConflict(
      "Resolve existing conflicts before reconciling the source"
    );
  if (existsSync(skillStatePath(`transactions/${ref.name}/journal.json`)))
    throw new SkillWorkspaceConflict(
      "適用の復旧が必要です。復旧後に正本を再調整してください。"
    );
  const current = resolveLocalSkill(workspace.ref);
  if (!current.root || !existsSync(current.root))
    throw new ValueError(
      "Current skill source is unavailable; working copy preserved"
    );
  const fingerprint = sourceFingerprint(workspace.ref);
  if (fingerprint === workspace.fingerprint)
    return viewSkill(workspace.ref, "work");
  const metadata = readFileSync(
    skillStatePath(`workspaces/${ref.name}/workspace.json`),
    "utf8"
  );
  mergeWorkspaceCopies(
    workspace,
    current.root,
    join(root, "original"),
    { fingerprint },
    { revision, metadata, fingerprint }
  );
  return viewSkill(workspace.ref, "work");
}

export async function discardSkillWorkspace(ref: SkillRef): Promise<SkillView> {
  ref = checkedRef(ref);
  const workspace = requireWorkspace(ref);
  if (existsSync(skillStatePath(`transactions/${ref.name}/journal.json`)))
    throw new SkillWorkspaceConflict(
      "適用の復旧が必要です。作業を破棄する前に復旧してください。"
    );
  trashPath(workspaceRoot(ref.name));
  return viewSkill(workspace.ref, "source");
}

export async function resolveSkillConflict(
  ref: SkillRef,
  path: string,
  choice: "work" | "upstream",
  revision: string
): Promise<SkillView> {
  ref = checkedRef(ref);
  const workspace = requireWorkspace(ref);
  const root = workspaceRoot(ref.name);
  const work = join(root, "files");
  if (typeof revision !== "string" || revision !== skillTreeHash(work))
    throw new SkillWorkspaceConflict(
      "The working copy changed; review the conflict again"
    );
  if (choice !== "work" && choice !== "upstream")
    throw new ValueError("Conflict choice must be work or upstream");
  if (typeof path !== "string" || !workspace.conflicts.includes(path))
    throw new ValueError("Pending conflict was not found");
  const target = skillFilePath(work, path);
  const savedWork = join(root, "conflict-work");
  const incomingRoot = existsSync(join(root, "conflict-incoming"))
    ? join(root, "conflict-incoming")
    : join(root, "pending-upstream");
  const selected = choice === "work" ? savedWork : incomingRoot;
  if (!existsSync(selected))
    throw new ValueError(
      "Pre-merge conflict snapshot is unavailable; edit the file to resolve it"
    );
  listSkillFiles(selected);
  const incoming = skillFilePath(selected, path);
  if (existsSync(incoming) && lstatSync(incoming).isFile()) {
    if (existsSync(target) && lstatSync(target).isDirectory())
      trashPath(target);
    atomicSkillWrite(
      work,
      path,
      readFileSync(incoming),
      (lstatSync(incoming).mode & 0o111) | 0o644
    );
  } else trashPath(target);
  workspace.conflicts = workspace.conflicts.filter((file) => file !== path);
  writeState(`workspaces/${ref.name}/workspace.json`, workspace);
  return viewSkill(workspace.ref, "work");
}
