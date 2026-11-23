import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Project,
  ProjectChange,
  ProjectPreview,
  ProjectSkill,
  ProjectSource,
  ProjectStatus,
} from "../../shared/project-types";
import {
  activeDir,
  archiveDir,
  catalogRoot,
  globalLockFile,
  projectsDir,
} from "./config";
import { canonicalPath, resolveCatalogPath } from "./catalogPaths";
import { customSkillRepoDir } from "./custom";
import { loadDeck, UnknownDeckError } from "./decks";
import { AlreadyExistsError, ValueError } from "./errors";
import { frontmatterName } from "../infrastructure/github";
import {
  frontmatterDescription,
  loadGlobalLock,
  type Lock,
  trackedSkills,
} from "./inventory";
import {
  assertSkillName,
  copySkillTree,
  listSkillFiles,
  skillFilePath,
  skillTreeHash,
  writeSkillJson,
} from "./skill-files";
import { splitLines, unifiedDiff } from "./diff";

// Codex と Antigravity は .agents/skills を直接読む（skills@1.7.6）。
const SKILL_DIRS = [".agents/skills", ".claude/skills"];
type Manifest = {
  version: 1;
  skills: Record<
    string,
    { source: ProjectSource; sourceVersion?: string | null; hash: string }
  >;
};

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name))
    throw new ValueError("Invalid project name");
}

function registryPath(name: string): string {
  validateName(name);
  return skillFilePath(projectsDir(), `${name}.json`);
}

function overlaps(a: string, b: string): boolean {
  const rel = relative(a, b);
  return (
    !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function validateProject(project: Project, allowMissing = false): Project {
  validateName(project.name);
  if (!isAbsolute(project.path))
    throw new ValueError("Project path must be an existing absolute directory");
  if (!existsSync(project.path)) {
    if (allowMissing) return project;
    throw new ValueError("Project path must be an existing absolute directory");
  }
  if (!statSync(project.path).isDirectory()) {
    if (allowMissing) return project;
    throw new ValueError("Project path must be an existing absolute directory");
  }
  if (allowMissing && lstatSync(project.path).isSymbolicLink())
    throw new ValueError(
      "Registered project root must not be replaced by a symlink"
    );
  const path = realpathSync(project.path);
  for (const dir of SKILL_DIRS) {
    const target = canonicalPath(join(path, dir));
    for (const global of [
      activeDir(),
      archiveDir(),
      globalLockFile(),
      projectsDir(),
    ]) {
      const protectedPath = canonicalPath(resolve(global));
      if (overlaps(target, protectedPath) || overlaps(protectedPath, target))
        throw new ValueError("Project skills must not overlap runtime paths");
    }
    skillFilePath(path, dir);
  }
  return {
    name: project.name,
    path,
    ...(project.deck ? { deck: project.deck } : {}),
  };
}

export function registerProject(
  name: string,
  path: string,
  deck?: string
): Project {
  const project = validateProject({ name, path, deck });
  if (deck) loadDeck(deck, new Set(), true);
  const file = registryPath(name);
  if (present(file))
    throw new AlreadyExistsError(`Project already exists: ${name}`);
  if (listProjects().some((p) => p.path === project.path))
    throw new AlreadyExistsError("Project path already registered");
  writeSkillJson(file, project);
  return project;
}

export function loadProject(name: string): Project {
  const file = registryPath(name);
  if (!present(file)) throw new ValueError(`Unknown project: ${name}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ValueError("Invalid project registry");
  }
  if (!value || typeof value !== "object")
    throw new ValueError("Invalid project registry");
  const p = value as Project;
  if (
    p.name !== name ||
    typeof p.path !== "string" ||
    (p.deck !== undefined && typeof p.deck !== "string")
  )
    throw new ValueError("Invalid project registry");
  return validateProject(p, true);
}

export function listProjects(): Project[] {
  if (!existsSync(projectsDir())) return [];
  return readdirSync(projectsDir())
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => loadProject(n.slice(0, -5)));
}

export function unregisterProject(name: string): void {
  validateName(name);
  if (!present(registryPath(name)))
    throw new ValueError(`Unknown project: ${name}`);
  rmSync(registryPath(name));
}

function manifestPath(project: Project): string {
  return skillFilePath(project.path, ".agents/skill-loom.json");
}

function loadManifest(project: Project): Manifest {
  const path = manifestPath(project);
  if (!present(path)) return { version: 1, skills: {} };
  let value: Manifest;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ValueError("Invalid project manifest");
  }
  if (
    !value ||
    value.version !== 1 ||
    !value.skills ||
    typeof value.skills !== "object" ||
    Array.isArray(value.skills)
  )
    throw new ValueError("Invalid project manifest");
  for (const [name, entry] of Object.entries(value.skills)) {
    assertSkillName(name);
    if (
      !entry ||
      !["custom", "vendor", "external"].includes(entry.source) ||
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      (entry.sourceVersion !== undefined &&
        entry.sourceVersion !== null &&
        typeof entry.sourceVersion !== "string")
    )
      throw new ValueError("Invalid project manifest entry");
  }
  return value;
}

function location(project: Project, dir: string, name: string): string {
  assertSkillName(name);
  return join(skillFilePath(project.path, dir), name);
}

function sourceFor(
  lock: Lock,
  name: string
): { path: string; kind: ProjectSource } | undefined {
  assertSkillName(name);
  let path: string | undefined;
  let kind: ProjectSource;
  if (Object.hasOwn(lock.vendor ?? {}, name)) {
    kind = "vendor";
    path = resolveCatalogPath(`vendor/${name}`);
  } else if (Object.hasOwn(lock.custom?.skills ?? {}, name)) {
    kind = "custom";
    path = customSkillRepoDir(lock, name) ?? undefined;
  } else if (Object.hasOwn(lock.external ?? {}, name)) {
    kind = "external";
    const local = lock.external?.[name]?.localRepoPath;
    if (local) path = resolveCatalogPath(local);
    if (!path || !existsSync(path)) path = join(activeDir(), name);
  } else return undefined;
  if (!path || !existsSync(path) || !statSync(path).isDirectory())
    return undefined;
  return { path: realpathSync(path), kind };
}

// プロジェクト外のリンクは表示だけに留め、内容を読まない。
function readableRoot(project: Project, path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const real = realpathSync(path);
  if (!overlaps(project.path, real) || !statSync(real).isDirectory())
    return undefined;
  return real;
}

function correctLink(project: Project, name: string): boolean {
  const link = location(project, ".claude/skills", name);
  return (
    present(link) &&
    lstatSync(link).isSymbolicLink() &&
    readlinkSync(link) === `../../.agents/skills/${name}`
  );
}

function gitOutput(path: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function sourceVersion(lock: Lock, name: string): string | null {
  const source = sourceFor(lock, name);
  if (!source) return null;
  if (overlaps(canonicalPath(catalogRoot()), source.path)) {
    const commit = gitOutput(catalogRoot(), ["rev-parse", "HEAD"]);
    if (commit)
      return (
        commit +
        (gitOutput(catalogRoot(), [
          "status",
          "--porcelain",
          "--",
          relative(catalogRoot(), source.path),
        ])
          ? "+dirty"
          : "")
      );
  }
  const entry = loadGlobalLock()[name];
  return entry?.skillFolderHash ?? entry?.ref ?? null;
}

export function projectStatus(
  name: string,
  lock: Lock,
  force = false
): ProjectStatus {
  const project = loadProject(name);
  if (!existsSync(project.path) || !statSync(project.path).isDirectory())
    return { project, state: "missing", dirty: null, skills: [], plan: [] };
  const manifest = loadManifest(project);
  let deckError: string | undefined;
  let deckSkills: string[] = [];
  try {
    if (project.deck) deckSkills = loadDeck(project.deck, new Set(), true)[1];
  } catch (error) {
    if (!(error instanceof UnknownDeckError)) throw error;
    deckError = error.message;
  }
  const desired = new Set(deckSkills);
  const names = new Set([...desired, ...Object.keys(manifest.skills)]);
  for (const dir of SKILL_DIRS) {
    const root = skillFilePath(project.path, dir);
    if (existsSync(root))
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        assertSkillName(entry.name);
        names.add(entry.name);
      }
  }
  const inventory = trackedSkills(lock);
  const plan: ProjectChange[] = [];
  const skills = [...names].sort().map<ProjectSkill>((skill) => {
    const paths = SKILL_DIRS.map((dir) => location(project, dir, skill));
    const locations = paths
      .filter(present)
      .map((p) => relative(project.path, p));
    const managed = Object.hasOwn(manifest.skills, skill);
    const primary = paths[0]!;
    const root = paths.map((p) => readableRoot(project, p)).find(Boolean);
    let hash = "missing";
    const restorable =
      managed && !present(primary) && correctLink(project, skill);
    let unsafe = locations.length > 0 && !root && !restorable;
    try {
      if (root) hash = skillTreeHash(root);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      unsafe = true;
    }
    const drifted =
      managed &&
      !restorable &&
      locations.length > 0 &&
      (unsafe ||
        !present(primary) ||
        lstatSync(primary).isSymbolicLink() ||
        hash !== manifest.skills[skill]!.hash ||
        !correctLink(project, skill));
    const source = sourceFor(lock, skill);
    const state = unsafe
      ? "conflict"
      : drifted
        ? "drifted"
        : managed
          ? root
            ? "managed"
            : "missing"
          : locations.length
            ? desired.has(skill)
              ? "conflict"
              : "unmanaged"
            : source
              ? "missing"
              : "unavailable";
    if (project.deck && (managed || desired.has(skill))) {
      let action: ProjectChange["action"] = "skip";
      let reason: string | undefined;
      if (unsafe) reason = "unsafe project skill";
      else if (drifted && !force) reason = "drifted";
      else if (!managed && locations.length) reason = "unmanaged conflict";
      else if (!desired.has(skill)) action = "remove";
      else if (!source) reason = "unavailable";
      else if (!managed || !root) action = "add";
      else if (
        drifted ||
        skillTreeHash(source.path) !== manifest.skills[skill]!.hash
      )
        action = "update";
      else reason = "unchanged";
      plan.push({ name: skill, action, ...(reason ? { reason } : {}) });
    }
    return {
      name: skill,
      displayName:
        root && !unsafe
          ? frontmatterName(join(root, "SKILL.md")) || skill
          : skill,
      description:
        root && !unsafe ? frontmatterDescription(join(root, "SKILL.md")) : "",
      state,
      managed,
      globalActive: existsSync(join(activeDir(), skill)),
      inventory: inventory.has(skill),
      available: Boolean(source),
      locations,
      sourceVersion: manifest.skills[skill]?.sourceVersion ?? null,
    };
  });
  const dirty = gitOutput(project.path, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...SKILL_DIRS,
    ".agents/skill-loom.json",
  ]);
  return {
    project,
    state: "ready",
    dirty: dirty === null ? null : Boolean(dirty),
    skills,
    plan: deckError ? [] : plan,
    ...(deckError ? { deckError } : {}),
  };
}

export function previewProjectSkill(
  name: string,
  skill: string,
  lock: Lock
): ProjectPreview {
  assertSkillName(skill);
  const status = projectStatus(name, lock);
  if (status.state === "missing")
    throw new ValueError("Project directory is missing");
  const source = sourceFor(lock, skill);
  if (!source) throw new ValueError(`Unavailable skill: ${skill}`);
  const sourceHash = skillTreeHash(source.path);
  const revision = createHash("sha256").update(sourceHash);
  const diffs: string[] = [];
  for (const dir of SKILL_DIRS) {
    const path = location(status.project, dir, skill);
    if (!present(path)) {
      revision.update(`${dir}:missing`);
      continue;
    }
    const root = readableRoot(status.project, path);
    if (
      !root &&
      dir === ".claude/skills" &&
      correctLink(status.project, skill) &&
      !present(location(status.project, ".agents/skills", skill))
    ) {
      revision.update(dir).update(readlinkSync(path)).update("missing");
      continue;
    }
    if (!root) throw new ValueError("Unsafe project skill");
    revision.update(dir).update(skillTreeHash(root));
    if (lstatSync(path).isSymbolicLink()) revision.update(readlinkSync(path));
    const before = new Map(listSkillFiles(root).map((f) => [f.path, f]));
    const after = new Map(listSkillFiles(source.path).map((f) => [f.path, f]));
    for (const file of [
      ...new Set([...before.keys(), ...after.keys()]),
    ].sort()) {
      const left = before.has(file)
        ? readFileSync(skillFilePath(root, file))
        : Buffer.alloc(0);
      const right = after.has(file)
        ? readFileSync(skillFilePath(source.path, file))
        : Buffer.alloc(0);
      const modeChanged =
        before.has(file) &&
        after.has(file) &&
        (lstatSync(skillFilePath(root, file)).mode & 0o111) !==
          (lstatSync(skillFilePath(source.path, file)).mode & 0o111);
      if (
        left.equals(right) &&
        before.has(file) === after.has(file) &&
        !modeChanged
      )
        continue;
      diffs.push(
        before.get(file)?.binary || after.get(file)?.binary
          ? `Binary file changed: ${dir}/${skill}/${file}`
          : unifiedDiff(
              splitLines(left.toString()),
              splitLines(right.toString()),
              `${dir}/${skill}/${file}`,
              `Inventory/${skill}/${file}`
            ) || `File metadata changed: ${file}`
      );
      if (modeChanged) diffs.push(`Executable mode changed: ${file}`);
    }
  }
  const row = status.skills.find((s) => s.name === skill);
  return {
    skill,
    diff:
      diffs.join("\n\n") ||
      "No content differences. Placement and manifest will be normalized.",
    revision: revision.digest("hex"),
    requiresConfirmation: Boolean(
      row?.locations.length && (!row.managed || row.state === "drifted")
    ),
  };
}

function deleteSkill(project: Project, name: string): void {
  for (const dir of [...SKILL_DIRS].reverse()) {
    const path = location(project, dir, name);
    if (present(path)) rmSync(path, { recursive: true, force: true });
  }
}

function putSkill(
  project: Project,
  name: string,
  lock: Lock,
  manifest: Manifest
): void {
  const source = sourceFor(lock, name);
  if (!source) throw new ValueError(`Unavailable skill: ${name}`);
  const target = location(project, ".agents/skills", name);
  if (overlaps(target, source.path) || overlaps(source.path, target))
    throw new ValueError("Project and source skill paths overlap");
  const stage = skillFilePath(
    project.path,
    `.agents/.skill-loom-${randomUUID()}`
  );
  try {
    copySkillTree(source.path, stage);
    const hash = skillTreeHash(stage);
    mkdirSync(dirname(target), { recursive: true });
    const link = location(project, ".claude/skills", name);
    mkdirSync(dirname(link), { recursive: true });
    deleteSkill(project, name);
    renameSync(stage, target);
    symlinkSync(`../../.agents/skills/${name}`, link);
    manifest.skills[name] = {
      source: source.kind,
      sourceVersion: sourceVersion(lock, name),
      hash,
    };
  } finally {
    if (present(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function syncProject(
  name: string,
  lock: Lock,
  options: { force?: boolean; dryRun?: boolean; revision?: string } = {}
): ProjectStatus {
  const status = projectStatus(name, lock, options.force);
  if (status.state === "missing")
    throw new ValueError("Project directory is missing");
  if (!status.project.deck) throw new ValueError("Project has no deck");
  if (status.deckError) throw new ValueError(status.deckError);
  const drifted = status.plan.filter(
    (c) =>
      c.action !== "skip" &&
      status.skills.find((s) => s.name === c.name)?.state === "drifted"
  );
  if (drifted.length) {
    const previews = drifted.map((c) =>
      c.action === "remove"
        ? {
            revision: SKILL_DIRS.map((dir) => {
              const path = location(status.project, dir, c.name);
              const root = readableRoot(status.project, path);
              return [
                dir,
                root ? skillTreeHash(root) : "missing",
                present(path) && lstatSync(path).isSymbolicLink()
                  ? readlinkSync(path)
                  : null,
              ];
            }),
            diff: `Remove drifted project skill: ${c.name}`,
          }
        : previewProjectSkill(name, c.name, lock)
    );
    status.review = {
      revision: createHash("sha256")
        .update(JSON.stringify([status.plan, previews]))
        .digest("hex"),
      diff: previews.map((p) => p.diff).join("\n\n"),
    };
    if (!options.dryRun && options.revision !== status.review.revision)
      throw new ValueError(
        "Preview force sync and confirm its current revision"
      );
  }
  if (options.dryRun) return status;
  const manifest = loadManifest(status.project);
  for (const change of status.plan) {
    if (change.action === "skip") continue;
    if (change.action === "remove") {
      deleteSkill(status.project, change.name);
      delete manifest.skills[change.name];
    } else putSkill(status.project, change.name, lock, manifest);
    writeSkillJson(manifestPath(status.project), manifest);
  }
  return { ...projectStatus(name, lock), plan: status.plan };
}

export function projectSkillAction(
  name: string,
  skill: string,
  action: "install" | "update" | "remove",
  lock: Lock,
  force = false,
  revision?: string
): ProjectStatus {
  assertSkillName(skill);
  const status = projectStatus(name, lock);
  if (status.state === "missing")
    throw new ValueError("Project directory is missing");
  const row = status.skills.find((r) => r.name === skill);
  const manifest = loadManifest(status.project);
  if (action === "remove") {
    if (!row || !row.locations.length)
      throw new ValueError(`Missing project skill: ${skill}`);
    deleteSkill(status.project, skill);
    delete manifest.skills[skill];
  } else {
    if (
      action === "install" &&
      row?.locations.length &&
      row.state !== "missing"
    )
      throw new AlreadyExistsError(
        `Project skill already exists: ${skill}; use update`
      );
    if (action === "update" && !row?.locations.length)
      throw new ValueError(`Missing project skill: ${skill}; use install`);
    if (row?.state === "conflict" && row.managed)
      throw new ValueError("Unsafe project skill");
    if (row?.state === "drifted" && !force)
      throw new ValueError("Project skill drifted; use force");
    if (action === "update") {
      const preview = previewProjectSkill(name, skill, lock);
      if (
        preview.requiresConfirmation &&
        (!force || revision !== preview.revision)
      )
        throw new ValueError(
          "Review the diff and confirm with its current revision"
        );
    }
    putSkill(status.project, skill, lock, manifest);
  }
  writeSkillJson(manifestPath(status.project), manifest);
  return projectStatus(name, lock);
}
