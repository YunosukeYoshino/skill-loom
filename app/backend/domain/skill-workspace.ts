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
import { loadLock, type Lock } from "./inventory";
import { checkedSkillRef as checkedRef } from "./skill-reference";
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

function validCheckTime(value: string | undefined): boolean {
  return value === undefined || Number.isFinite(Date.parse(value));
}

function validAttemptTime(status: SkillUpstreamStatus): boolean {
  if (!("attemptedAt" in status) || status.attemptedAt === undefined)
    return true;
  return (
    typeof status.attemptedAt === "string" &&
    Number.isFinite(Date.parse(status.attemptedAt))
  );
}

function validateUpstreamStatus(status: SkillUpstreamStatus): void {
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
    ].includes(status.state)
  )
    throw new ValueError("Invalid upstream status metadata");
  const validLag =
    status.behind === null ||
    (Number.isSafeInteger(status.behind) && status.behind >= 0);
  if (
    !validLag ||
    !validCheckTime(status.checkedAt) ||
    !validAttemptTime(status)
  )
    throw new ValueError("Invalid upstream status metadata");
  checkedVersion(status.baseline);
  checkedVersion(status.latest);
}

function readTracking(ref: SkillRef): Tracking | undefined {
  const data = readState<Tracking>(`tracking/${ref.name}.json`);
  if (!data) return undefined;
  data.ref = checkedRef(data.ref);
  assertSameRef(data.ref, ref);
  checkedVersion(data.baseline);
  if (data.status !== undefined) validateUpstreamStatus(data.status);
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

export function renderSkillMarkdown(content: unknown): string {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > SKILL_TEXT_LIMIT
  )
    throw new ValueError("Text exceeds the 1 MiB edit limit");
  return Bun.markdown.html(content);
}

export function requireWorkspace(ref: SkillRef): SkillWorkspace {
  ref = checkedRef(ref);
  const workspace = loadSkillWorkspace(ref.name);
  if (!workspace) throw new ValueError("Fork this skill before editing");
  assertSameRef(workspace.ref, ref);
  return workspace;
}

function reviewedWorkspace(ref: SkillRef, revision: string, message: string) {
  const workspace = requireWorkspace(ref);
  const root = workspaceRoot(ref.name);
  const work = join(root, "files");
  if (typeof revision !== "string" || revision !== skillTreeHash(work))
    throw new SkillWorkspaceConflict(message);
  return { workspace, root, work };
}

export async function saveSkillFile(
  ref: SkillRef,
  path: string,
  content: string,
  revision: string
): Promise<SkillView> {
  const { workspace, work: root } = reviewedWorkspace(
    ref,
    revision,
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

type ResolvedSkill = {
  ref: SkillRef;
  kind: SkillView["kind"];
  root?: string;
};

function inventorySkillRef(
  ref: SkillRef,
  meta: Pick<SkillRef, "source" | "skillPath"> | undefined
): SkillRef {
  const resolved = checkedRef({
    ...ref,
    source: ref.source ?? meta?.source,
    skillPath: ref.skillPath ?? meta?.skillPath,
  });
  if (ref.source && meta?.source && ref.source !== meta.source.toLowerCase())
    throw new SkillWorkspaceConflict("A different source owns this skill");
  return resolved;
}

function trackedSkillRef(ref: SkillRef, lock: Lock): SkillRef {
  const meta = lock.vendor?.[ref.name] ?? lock.external?.[ref.name];
  const resolved = inventorySkillRef(ref, meta);
  const tracking = readTracking(resolved);
  if (!tracking) return resolved;
  return checkedRef({
    ...tracking.ref,
    ...resolved,
    skillPath: resolved.skillPath ?? tracking.ref.skillPath,
  });
}

function authoredSkillSource(
  ref: SkillRef,
  lock: Lock
): ResolvedSkill | undefined {
  if (lock.custom?.skills?.[ref.name])
    return {
      ref,
      kind: "custom",
      root: customSkillRepoDir(lock, ref.name) ?? undefined,
    };
  if (lock.vendor?.[ref.name])
    return {
      ref,
      kind: "vendor",
      root: resolveCatalogPath(`vendor/${ref.name}`),
    };
  return undefined;
}

function externalSkillSource(ref: SkillRef, repoPath?: string): ResolvedSkill {
  const catalog = repoPath ? resolveCatalogPath(repoPath) : undefined;
  const saved = readSourceSnapshot(ref);
  return {
    ref: saved?.ref ?? ref,
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

function untrackedSkillSource(ref: SkillRef): ResolvedSkill {
  const saved = readSourceSnapshot(ref);
  return {
    ref: saved?.ref ?? ref,
    kind: ref.source ? "external" : "untracked",
    root:
      (ref.source ? undefined : installedSkillRoot(ref.name)) ??
      (saved
        ? skillStatePath(`source-snapshots/${ref.name}/files`)
        : undefined),
  };
}

function resolveLocalSkill(ref: SkillRef): ResolvedSkill {
  ref = checkedRef(ref);
  const lock = loadLock();
  const resolved = trackedSkillRef(ref, lock);
  const authored = authoredSkillSource(resolved, lock);
  if (authored) return authored;
  if (lock.external?.[ref.name])
    return externalSkillSource(
      resolved,
      lock.external[ref.name]?.localRepoPath
    );
  const draft = draftSkillMap().get(ref.name);
  if (draft)
    return {
      ref: resolved,
      kind: "draft",
      root: resolveCatalogPath(draft.repoPath),
    };
  return untrackedSkillSource(resolved);
}

function recordFetchedBaseline(ref: SkillRef, version: UpstreamVersion): void {
  const tracking = readTracking(ref);
  const lock = loadLock();
  const baseline =
    tracking?.baseline ??
    (!lock.external?.[ref.name] && !lock.vendor?.[ref.name]
      ? version
      : undefined);
  writeState(`tracking/${ref.name}.json`, { ...tracking, ref, baseline });
}

async function resolveSkill(ref: SkillRef): Promise<ResolvedSkill> {
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
  recordFetchedBaseline(fetched.ref, fetched.version);
  return { ...local, ref: fetched.ref, root };
}

function retainedBaselineRoot(
  ref: SkillRef,
  baseline: UpstreamVersion | undefined
): string | undefined {
  const saved = readSourceSnapshot(ref);
  if (saved && saved.version.commit === baseline?.commit)
    return skillStatePath(`source-snapshots/${ref.name}/files`);
  return undefined;
}

function baselineRoot(
  ref: SkillRef,
  workspace?: SkillWorkspace
): string | undefined {
  const working = join(workspaceRoot(ref.name), "baseline");
  if (workspace && existsSync(working)) return working;
  const upstream = resolveCatalogPath(`upstream/${ref.name}`);
  if (existsSync(upstream)) return upstream;
  return retainedBaselineRoot(
    ref,
    workspace?.baseline ?? readTracking(ref)?.baseline
  );
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

function skillVersionRoots(local: ResolvedSkill, workspace?: SkillWorkspace) {
  const installed = installedSkillRoot(local.ref.name);
  const baseline = baselineRoot(local.ref, workspace);
  const cached = local.ref.source ? readCachedSkillSnapshot(local.ref) : null;
  const roots = {
    source: local.root,
    upstream: cached?.root,
    baseline,
    work: workspace ? join(workspaceRoot(local.ref.name), "files") : undefined,
    installed,
  };
  const versions: SkillVersion[] = ["source"];
  for (const version of ["upstream", "baseline", "work", "installed"] as const)
    if (roots[version]) versions.push(version);
  return { roots, versions, baseline };
}

function selectedVersionRoot(
  version: SkillVersion,
  roots: ReturnType<typeof skillVersionRoots>["roots"],
  workspace?: SkillWorkspace
): string {
  if (version === "work" && !workspace)
    throw new ValueError("Version is not available");
  const root = roots[version];
  if (!root || !existsSync(root))
    throw new ValueError("Skill source is not available");
  return root;
}

function readSkillContent(root: string, file: string) {
  const files = listSkillFiles(root);
  const selected = files.find((row) => row.path === file);
  skillFilePath(root, file);
  if (!selected) throw new ValueError("Skill file not found");
  const data = selected.binary
    ? null
    : readFileSync(skillFilePath(root, file)).subarray(0, SKILL_TEXT_LIMIT);
  const content = data?.toString("utf8") ?? null;
  return {
    files,
    selectedFile: file,
    content,
    html:
      content !== null && /\.md$/i.test(file)
        ? renderSkillMarkdown(content)
        : null,
    binary: selected.binary,
    truncated: selected.size > SKILL_TEXT_LIMIT,
  };
}

function comparisonRoot(
  version: SkillVersion,
  baseline: string | undefined,
  workspace?: SkillWorkspace
): string | undefined {
  if (version === "baseline") return undefined;
  return (
    baseline ??
    (workspace && version === "work"
      ? join(workspaceRoot(workspace.ref.name), "original")
      : undefined)
  );
}

function skillVersionDiff(
  version: SkillVersion,
  root: string,
  baseline: string | undefined,
  knownBaseline: UpstreamVersion | undefined,
  workspace?: SkillWorkspace
): string {
  if (version === "upstream" && !knownBaseline)
    return "Comparison unavailable: baseline unknown";
  if (version === "upstream" && !baseline)
    return "Comparison unavailable: baseline snapshot unavailable";
  const comparison = comparisonRoot(version, baseline, workspace);
  if (!comparison) return "";
  const prefix = knownBaseline
    ? ""
    : "Comparison against retained source snapshot (upstream baseline unknown)\n";
  return prefix + treeDiff(comparison, root);
}

function workspaceViewState(workspace: SkillWorkspace, baseChanged: boolean) {
  const root = workspaceRoot(workspace.ref.name);
  return {
    dirty:
      skillTreeHash(join(root, "files")) !==
      skillTreeHash(join(root, "original")),
    conflicts: workspace.conflicts,
    issues: validateSkillWorkspace(workspace.ref.name),
    baseChanged,
  };
}

function savedUpstreamStatus(
  tracking: Tracking | undefined,
  workspace: SkillWorkspace | undefined
): SkillUpstreamStatus {
  return (
    tracking?.status ?? {
      state: "unchecked",
      baseline: tracking?.baseline ?? workspace?.baseline,
      behind: null,
    }
  );
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
  const { roots, versions, baseline } = skillVersionRoots(local, workspace);
  const root = selectedVersionRoot(version, roots, workspace);
  const selected = readSkillContent(root, file);
  const tracking = readTracking(local.ref);
  const baseChanged = workspace
    ? workspace.fingerprint !== sourceFingerprint(workspace.ref)
    : false;
  const recovery = existsSync(
    skillStatePath(`transactions/${ref.name}/journal.json`)
  );
  const diff = skillVersionDiff(
    version,
    root,
    baseline,
    tracking?.baseline ?? workspace?.baseline,
    workspace
  );
  const message = recovery
    ? "適用の復旧が必要です。復旧後に作業を再開してください。"
    : baseChanged
      ? "正本が別の操作で変更されています。版を比較し、正本を再調整して作業内容と統合してください。"
      : undefined;
  return {
    ref: local.ref,
    kind: local.kind,
    version,
    versions,
    ...selected,
    revision: skillTreeHash(root),
    diff,
    upstream: savedUpstreamStatus(tracking, workspace),
    ...(message ? { message } : {}),
    ...(workspace
      ? { workspace: workspaceViewState(workspace, baseChanged) }
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
  const failed = upstreamNeedsReview(checked.state);
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

type MergeChange = { pending: UpstreamVersion } | { fingerprint: string };
type MergeReview = { revision: string; metadata: string; fingerprint: string };

function upstreamNeedsReview(state: SkillUpstreamStatus["state"]): boolean {
  return ["missing", "unavailable", "review"].includes(state);
}

function usableMergeBase(
  workspace: SkillWorkspace,
  base: string | undefined,
  state: SkillUpstreamStatus["state"]
): string | undefined {
  if (
    !(workspace.pending ?? workspace.baseline) ||
    state === "unknown" ||
    !base ||
    !existsSync(base)
  )
    return undefined;
  return base;
}

async function upstreamMergeBase(
  workspace: SkillWorkspace,
  root: string,
  state: SkillUpstreamStatus["state"]
): Promise<string | undefined> {
  let base = workspace.pending
    ? join(root, "pending-upstream")
    : baselineRoot(workspace.ref, workspace);
  if (workspace.pending) {
    const status = await checkSkillUpstream(
      workspace.ref,
      workspace.pending,
      false
    );
    if (upstreamNeedsReview(status.state))
      throw new SkillWorkspaceConflict(
        status.message ?? "Pending upstream needs review"
      );
    if (status.state === "unknown") base = undefined;
  }
  return usableMergeBase(workspace, base, state);
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
  const revision = skillTreeHash(join(root, "files"));
  const metadata = readFileSync(
    skillStatePath(`workspaces/${ref.name}/workspace.json`),
    "utf8"
  );
  const checked = await checkSkillUpdates(workspace.ref);
  if (upstreamNeedsReview(checked.upstream.state))
    throw new SkillWorkspaceConflict(
      checked.upstream.message ?? "Upstream needs review before merging"
    );
  const latest = readCachedSkillSnapshot(workspace.ref);
  if (!latest) throw new ValueError("Upstream snapshot is not available");
  const base = await upstreamMergeBase(workspace, root, checked.upstream.state);
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

type MergeTrees = {
  work: string;
  incoming: string;
  base: string | undefined;
  stagedWork: string;
};
type MergeFile = { bytes: Buffer | undefined; mode: number | undefined };
type MergeVersions = {
  ours: MergeFile;
  theirs: MergeFile;
  original: MergeFile;
};

function readMergeFile(dir: string | undefined, path: string): MergeFile {
  const bytes =
    dir &&
    existsSync(skillFilePath(dir, path)) &&
    lstatSync(skillFilePath(dir, path)).isFile()
      ? readFileSync(skillFilePath(dir, path))
      : undefined;
  const mode =
    bytes && dir ? lstatSync(skillFilePath(dir, path)).mode & 0o111 : undefined;
  return { bytes, mode };
}

function sameMergeFile(left: MergeFile, right: MergeFile): boolean {
  return sameBytes(left.bytes, right.bytes) && left.mode === right.mode;
}

function mergeObstruction(stagedWork: string, path: string): boolean {
  let ancestor = skillFilePath(stagedWork, path);
  let obstruction = existsSync(ancestor) && lstatSync(ancestor).isDirectory();
  while (dirname(ancestor) !== stagedWork) {
    ancestor = dirname(ancestor);
    if (existsSync(ancestor) && !lstatSync(ancestor).isDirectory())
      obstruction = true;
  }
  return obstruction;
}

function mergeUnchangedFile(
  trees: MergeTrees,
  path: string,
  theirs: MergeFile
): boolean {
  const obstruction = mergeObstruction(trees.stagedWork, path);
  if (theirs.bytes && obstruction) return true;
  if (theirs.bytes)
    atomicSkillWrite(
      trees.stagedWork,
      path,
      theirs.bytes,
      (lstatSync(skillFilePath(trees.incoming, path)).mode & 0o777) | 0o600
    );
  else trashPath(skillFilePath(trees.stagedWork, path));
  return false;
}

function mergeCustomizedFile(
  trees: MergeTrees,
  path: string,
  base: string,
  versions: MergeVersions
): boolean {
  const { ours, theirs, original } = versions;
  if (
    ![ours, original, theirs].every((file) => file.bytes && isText(file.bytes))
  )
    return true;
  const merged = mergeText(
    skillFilePath(trees.work, path),
    skillFilePath(base, path),
    skillFilePath(trees.incoming, path)
  );
  if (!merged) return true;
  atomicSkillWrite(
    trees.stagedWork,
    path,
    merged.bytes,
    ((ours.mode === original.mode ? theirs.mode : ours.mode) ?? 0) | 0o644
  );
  return merged.conflict;
}

function mergeWorkspaceFile(trees: MergeTrees, path: string): boolean {
  const ours = readMergeFile(trees.work, path);
  const theirs = readMergeFile(trees.incoming, path);
  const original = readMergeFile(trees.base, path);
  if (sameMergeFile(ours, theirs)) return false;
  if (!trees.base) return true;
  if (sameMergeFile(theirs, original)) return false;
  if (sameMergeFile(ours, original))
    return mergeUnchangedFile(trees, path, theirs);
  return mergeCustomizedFile(trees, path, trees.base, {
    ours,
    theirs,
    original,
  });
}

function stageWorkspaceMerge(
  workspace: SkillWorkspace,
  incoming: string,
  change: MergeChange
) {
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
  return { root, work, stage, stagedWork, incomingKey, preserveStage: false };
}

type WorkspaceMerge = ReturnType<typeof stageWorkspaceMerge>;

function assertMergeReview(
  workspace: SkillWorkspace,
  work: string,
  review: MergeReview
): void {
  if (
    review.revision !== skillTreeHash(work) ||
    review.metadata !==
      readFileSync(
        skillStatePath(`workspaces/${workspace.ref.name}/workspace.json`),
        "utf8"
      ) ||
    review.fingerprint !== sourceFingerprint(workspace.ref)
  )
    throw new SkillWorkspaceConflict(
      "The working copy or source changed during the merge; review and retry"
    );
}

function restoreMergeCopies(
  merge: WorkspaceMerge,
  installed: string[],
  replaced: string[]
): void {
  for (const key of installed.reverse()) trashPath(join(merge.root, key));
  for (const key of replaced.reverse())
    renameSync(join(merge.stage, `previous-${key}`), join(merge.root, key));
}

function installMergeCopies(
  merge: WorkspaceMerge,
  workspace: SkillWorkspace,
  change: MergeChange,
  conflicts: string[]
): void {
  const { root, stage, incomingKey } = merge;
  const replaced: string[] = [];
  const installed: string[] = [];
  merge.preserveStage = true;
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
    writeState(`workspaces/${workspace.ref.name}/workspace.json`, {
      ...workspace,
      ...change,
      conflicts,
    });
  } catch (error) {
    try {
      restoreMergeCopies(merge, installed, replaced);
      merge.preserveStage = false;
    } catch (recovery) {
      throw new Error(
        `Workspace merge recovery is required; backups retained at ${stage}: ${String(error)} / ${String(recovery)}`
      );
    }
    throw error;
  }
  merge.preserveStage = false;
}

function mergeWorkspaceCopies(
  workspace: SkillWorkspace,
  incoming: string,
  base: string | undefined,
  change: MergeChange,
  review: MergeReview
): void {
  const merge = stageWorkspaceMerge(workspace, incoming, change);
  const { work, stagedWork, stage } = merge;
  const paths = new Set(
    [
      ...listSkillFiles(work),
      ...listSkillFiles(incoming),
      ...(base ? listSkillFiles(base) : []),
    ].map((file) => file.path)
  );
  const conflicts: string[] = [];
  const trees = { work, incoming, base, stagedWork };
  try {
    for (const path of [...paths].sort())
      if (mergeWorkspaceFile(trees, path)) conflicts.push(path);
    listSkillFiles(stagedWork);
    assertMergeReview(workspace, work, review);
    installMergeCopies(merge, workspace, change, conflicts);
  } catch (error) {
    if (!merge.preserveStage) trashPath(stage);
    throw error;
  }
  trashPath(stage);
}

export async function reconcileSkillSource(
  ref: SkillRef,
  revision: string
): Promise<SkillView> {
  ref = checkedRef(ref);
  const { workspace, root } = reviewedWorkspace(
    ref,
    revision,
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
  const { workspace, root, work } = reviewedWorkspace(
    ref,
    revision,
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
