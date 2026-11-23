import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listProjects,
  importProjectSkill,
  previewProjectSkill,
  projectSkillAction,
  projectStatus,
  registerProject,
  syncProject,
  unregisterProject,
} from "./projects";
import { AlreadyExistsError, ValueError } from "./errors";
import type { Lock } from "./inventory";
import { createProjectRoutes } from "../projectRoutes";
import { draftSkillMap, promoteDrafts } from "./drafts";

let root: string;
let project: string;
let lock: Lock;
let saved: Record<string, string | undefined>;
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function deck(skills: string[]) {
  write(
    join(root, "catalog/project-decks/work.json"),
    JSON.stringify({ extends: ["parent"], skills })
  );
}
function source(name = "alpha", text = "original") {
  write(
    join(root, `catalog/skills/dev/${name}/SKILL.md`),
    `---\nname: ${name}\ndescription: ${text}\n---\n${text}`
  );
}
function copyPath(name = "alpha") {
  return join(project, ".agents/skills", name, "SKILL.md");
}
function forceSync() {
  const preview = syncProject("work", lock, { force: true, dryRun: true });
  return syncProject("work", lock, {
    force: true,
    revision: preview.review?.revision,
  });
}
test("sources without SKILL.md are unavailable and never overwrite a good project copy", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  const before = readFileSync(copyPath(), "utf8");
  rmSync(join(root, "catalog/skills/dev/alpha/SKILL.md"));
  write(join(root, "catalog/skills/dev/alpha/other.txt"), "Broken source");
  expect(projectStatus("work", lock).skills[0]?.available).toBe(false);
  expect(syncProject("work", lock).plan[0]).toMatchObject({
    action: "skip",
    reason: "unavailable",
  });
  expect(readFileSync(copyPath(), "utf8")).toBe(before);
  expect(() => projectSkillAction("work", "alpha", "update", lock)).toThrow(
    "Unavailable"
  );
  lock.external = {
    remote: {
      source: "owner/repo",
      localRepoPath: "upstream/remote",
    },
  };
  write(
    join(root, "catalog/upstream/remote/other.txt"),
    "Incomplete Catalog copy"
  );
  write(join(root, "runtime/active/remote/SKILL.md"), "Active fallback");
  expect(
    projectSkillAction("work", "remote", "install", lock).skills.find(
      (s) => s.name === "remote"
    )?.available
  ).toBe(true);
});

test("a missing deck leaves status and individual actions usable but blocks sync", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  rmSync(join(root, "catalog/project-decks/work.json"));
  const status = projectStatus("work", lock);
  expect(status.deckError).toContain("Unknown project deck");
  expect(status.plan).toEqual([]);
  expect(status.skills[0]?.state).toBe("managed");
  expect(() => syncProject("work", lock, { force: true })).toThrow(
    "Unknown project deck"
  );
  expect(projectSkillAction("work", "alpha", "remove", lock).skills).toEqual(
    []
  );
  expect(
    projectSkillAction("work", "alpha", "install", lock).skills[0]?.state
  ).toBe("managed");
  expect(previewProjectSkill("work", "alpha", lock).requiresConfirmation).toBe(
    false
  );
  expect(
    projectSkillAction("work", "alpha", "update", lock).skills[0]?.state
  ).toBe("managed");
});

test("a managed skill with its expected dangling link can be restored", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  rmSync(join(project, ".agents/skills/alpha"), { recursive: true });
  expect(projectStatus("work", lock).plan[0]?.reason).not.toBe(
    "unsafe project skill"
  );
  expect(forceSync().skills[0]?.state).toBe("managed");
  rmSync(join(project, ".agents/skills/alpha"), { recursive: true });
  const preview = previewProjectSkill("work", "alpha", lock);
  expect(preview.diff).toContain("Inventory/alpha/SKILL.md");
  expect(preview.diff).toContain("+original");
  expect(preview.diff.match(/\+original/g)).toHaveLength(1);
  expect(preview.diff).toContain(
    "Recreate link: .claude/skills/alpha -> ../../.agents/skills/alpha"
  );
  expect(
    projectSkillAction("work", "alpha", "update", lock, true, preview.revision)
      .skills[0]?.state
  ).toBe("managed");
  rmSync(join(project, ".agents/skills/alpha"), { recursive: true });
  expect(
    projectSkillAction("work", "alpha", "install", lock).skills[0]?.state
  ).toBe("managed");
});

test("forced removal reviews hash regular Claude files and reject stale approval", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  const claude = join(project, ".claude/skills/alpha");
  rmSync(claude);
  write(claude, "A file replaced the link");
  deck([]);
  const preview = syncProject("work", lock, { force: true, dryRun: true });
  expect(preview.review?.diff).toContain("Remove file: .claude/skills/alpha");
  write(claude, "Edited after review");
  expect(() =>
    syncProject("work", lock, {
      force: true,
      revision: preview.review?.revision,
    })
  ).toThrow("current revision");
  expect(readFileSync(claude, "utf8")).toBe("Edited after review");
  expect(forceSync().skills).toEqual([]);
  expect(existsSync(claude)).toBe(false);
  expect(existsSync(copyPath())).toBe(false);
});

test("forced removal caps regular Claude files at 50 MiB but accepts empty files", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  const claude = join(project, ".claude/skills/alpha");
  rmSync(claude);
  write(claude, "");
  truncateSync(claude, 50 * 1024 * 1024 + 1);
  deck([]);
  expect(() =>
    syncProject("work", lock, { force: true, dryRun: true })
  ).toThrow("50 MiB");
  expect(existsSync(copyPath())).toBe(true);
  expect(existsSync(claude)).toBe(true);
  truncateSync(claude, 0);
  expect(forceSync().skills).toEqual([]);
  expect(existsSync(claude)).toBe(false);
});

test("forced removal reviews do not inspect targets of links being removed", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  const claude = join(project, ".claude/skills/alpha");
  const shared = join(project, "shared/alpha");
  write(join(shared, "SKILL.md"), "Shared skill");
  symlinkSync("SKILL.md", join(shared, "reference.md"));
  rmSync(claude);
  symlinkSync("../../shared/alpha", claude);
  deck([]);
  const preview = syncProject("work", lock, { force: true, dryRun: true });
  write(join(shared, "SKILL.md"), "Shared edit after review");
  syncProject("work", lock, {
    force: true,
    revision: preview.review?.revision,
  });
  expect(existsSync(copyPath())).toBe(false);
  expect(existsSync(claude)).toBe(false);
  expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe(
    "Shared edit after review"
  );
  expect(readlinkSync(join(shared, "reference.md"))).toBe("SKILL.md");
});

test("forced removal review rejects changes to an independent Claude copy", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  const claude = join(project, ".claude/skills/alpha");
  rmSync(claude);
  write(join(claude, "SKILL.md"), "Independent Claude copy");
  deck([]);
  const preview = syncProject("work", lock, { force: true, dryRun: true });
  write(join(claude, "SKILL.md"), "Edited after review");
  expect(() =>
    syncProject("work", lock, {
      force: true,
      revision: preview.review?.revision,
    })
  ).toThrow("current revision");
  expect(readFileSync(join(claude, "SKILL.md"), "utf8")).toBe(
    "Edited after review"
  );
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-projects-"));
  project = join(root, "repo");
  mkdirSync(project);
  const env = {
    MY_SKILLS_CATALOG_DIR: join(root, "catalog"),
    MY_SKILLS_PROJECTS_DIR: join(root, "runtime/projects"),
    MY_SKILLS_ACTIVE_DIR: join(root, "runtime/active"),
    MY_SKILLS_ARCHIVE_DIR: join(root, "runtime/archive"),
    MY_SKILLS_GLOBAL_LOCK_FILE: join(root, "runtime/lock.json"),
    MY_SKILLS_AUTO_COMMIT: "0",
    GIT_AUTHOR_NAME: "Skill Loom Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Skill Loom Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    MY_SKILLS_TRASH_BIN: join(root, "trash"),
    MY_SKILLS_LOCK_FILE: join(root, "catalog/skills.lock.json"),
    MY_SKILLS_PROJECT_DECKS_DIR: join(root, "catalog/project-decks"),
  };
  saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  lock = {
    version: 1,
    custom: {
      repo: "test/catalog",
      skills: { alpha: { repoPath: "skills/dev/alpha", category: "dev" } },
    },
    external: {},
    vendor: {},
  };
  write(join(root, "catalog/skills.lock.json"), JSON.stringify(lock));
  write(join(root, "catalog/shared-decks/parent.json"), '{"skills":[]}');
  write(
    join(root, "catalog/shared-decks/core.json"),
    '{"skills":["not-included"]}'
  );
  source();
  deck(["alpha"]);
  write(
    join(root, "trash"),
    '#!/bin/sh\nfor path in "$@"; do mv "$path" "$path.trashed"; done\n'
  );
  chmodSync(join(root, "trash"), 0o755);
});

test("imports a project-only skill as a Draft without changing project or Inventory, then adopts after promotion", () => {
  registerProject("work", project);
  const content =
    "---\nname: local-skill\ndescription: Project-only skill\n---\nHello";
  write(copyPath("local-skill"), content);
  write(join(project, ".agents/skills/local-skill/reference.txt"), "reference");
  const beforeLock = readFileSync(
    join(root, "catalog/skills.lock.json"),
    "utf8"
  );
  const result = importProjectSkill("work", "local-skill", lock);
  expect(result.importedDraft).toMatchObject({
    name: "local-skill",
    category: "imported",
    description: "Project-only skill",
  });
  expect(draftSkillMap().get("local-skill")?.repoPath).toBe(
    "drafts/skills/imported/local-skill"
  );
  expect(
    readFileSync(
      join(root, "catalog/drafts/skills/imported/local-skill/reference.txt"),
      "utf8"
    )
  ).toBe("reference");
  expect(readFileSync(copyPath("local-skill"), "utf8")).toBe(content);
  expect(readFileSync(join(root, "catalog/skills.lock.json"), "utf8")).toBe(
    beforeLock
  );
  expect(existsSync(join(project, ".agents/skill-loom.json"))).toBe(false);
  expect(existsSync(join(root, "runtime/active"))).toBe(false);
  expect(existsSync(join(root, "runtime/lock.json"))).toBe(false);
  const [, promotedLock] = promoteDrafts(new Set(["local-skill"]));
  const preview = previewProjectSkill("work", "local-skill", promotedLock);
  expect(preview.requiresConfirmation).toBe(true);
  expect(
    projectSkillAction(
      "work",
      "local-skill",
      "update",
      promotedLock,
      true,
      preview.revision
    ).skills[0]?.state
  ).toBe("managed");
});

test("import rejects empty/missing sources, Inventory and Draft names, and unsafe categories", () => {
  registerProject("work", project);
  expect(() => importProjectSkill("work", "unknown", lock)).toThrow(ValueError);
  mkdirSync(join(project, ".agents/skills/empty"), { recursive: true });
  expect(() => importProjectSkill("work", "empty", lock)).toThrow("SKILL.md");
  write(copyPath("alpha"), "alpha");
  expect(() => importProjectSkill("work", "alpha", lock)).toThrow(
    AlreadyExistsError
  );
  write(copyPath("local"), "Local skill");
  for (const category of ["../escape", "/tmp/escape", "", "dev/nested"])
    expect(() => importProjectSkill("work", "local", lock, category)).toThrow(
      ValueError
    );
  write(
    join(root, "catalog/drafts/skills/other/different-dir/SKILL.md"),
    "---\nname: local\n---\nDraft"
  );
  expect(() => importProjectSkill("work", "local", lock)).toThrow(
    AlreadyExistsError
  );
});

test("import rejects ignored registered Custom Skills rather than creating hidden Drafts", () => {
  registerProject("work", project);
  write(copyPath("alpha"), "Project alpha");
  write(
    join(root, "catalog/.skills-ignore.json"),
    JSON.stringify({ ignore: ["alpha"] })
  );
  expect(projectStatus("work", lock).skills[0]?.inventory).toBe(false);
  expect(() => importProjectSkill("work", "alpha", lock)).toThrow(
    AlreadyExistsError
  );
  expect(draftSkillMap().has("alpha")).toBe(false);
});

test("an unreadable secondary import copy does not break the project listing", () => {
  registerProject("work", project);
  write(copyPath("local"), "Local skill");
  write(copyPath("healthy"), "Healthy skill");
  const privateFile = join(project, ".claude/skills/local/private.txt");
  write(join(project, ".claude/skills/local/SKILL.md"), "Local skill");
  write(privateFile, "Unreadable content");
  chmodSync(privateFile, 0o000);
  try {
    const status = projectStatus("work", lock);
    expect(status.skills.find((s) => s.name === "local")).toMatchObject({
      importable: false,
      importError: expect.stringContaining("EACCES"),
    });
    expect(status.skills.find((s) => s.name === "healthy")?.importable).toBe(
      true
    );
  } finally {
    chmodSync(privateFile, 0o600);
  }
});

test("a safe unmanaged deck conflict remains importable without an Inventory match", () => {
  deck(["local"]);
  registerProject("work", project, "work");
  write(copyPath("local"), "Local project skill");
  expect(projectStatus("work", lock).skills[0]).toMatchObject({
    state: "conflict",
    inventory: false,
    importable: true,
  });
  expect(importProjectSkill("work", "local", lock).importedDraft.name).toBe(
    "local"
  );
  write(join(project, ".claude/skills/local/SKILL.md"), "Different local copy");
  expect(projectStatus("work", lock).skills[0]?.importable).toBe(false);
  rmSync(join(project, ".claude/skills/local"), { recursive: true });
  symlinkSync(
    join(root, "catalog/skills/dev/alpha"),
    join(project, ".agents/skills/unsafe")
  );
  expect(
    projectStatus("work", lock).skills.find((s) => s.name === "unsafe")
      ?.importable
  ).toBe(false);
});

test("import safely handles Claude-only and linked copies and rejects conflicting or escaped copies", () => {
  registerProject("work", project);
  write(join(project, ".claude/skills/claude-only/SKILL.md"), "Claude only");
  expect(
    importProjectSkill("work", "claude-only", lock, "team").importedDraft
      .category
  ).toBe("team");
  write(copyPath("linked"), "Linked skill");
  symlinkSync(
    "../../.agents/skills/linked",
    join(project, ".claude/skills/linked")
  );
  expect(importProjectSkill("work", "linked", lock).importedDraft.name).toBe(
    "linked"
  );
  write(copyPath("conflict"), "Agents copy");
  write(join(project, ".claude/skills/conflict/SKILL.md"), "Claude copy");
  expect(() => importProjectSkill("work", "conflict", lock)).toThrow(
    "copies differ"
  );
  symlinkSync(
    join(root, "catalog/skills/dev/alpha"),
    join(project, ".agents/skills/escape")
  );
  expect(() => importProjectSkill("work", "escape", lock)).toThrow("Unsafe");
  write(copyPath("bad-name"), "---\nname: other-name\n---\nSkill");
  expect(() => importProjectSkill("work", "bad-name", lock)).toThrow(
    "frontmatter name"
  );
  write(copyPath("nested-link"), "Skill");
  symlinkSync(
    copyPath("linked"),
    join(project, ".agents/skills/nested-link/link")
  );
  expect(() => importProjectSkill("work", "nested-link", lock)).toThrow(
    ValueError
  );
  symlinkSync(project, join(root, "catalog/drafts/skills/escaped"));
  write(copyPath("safe-import"), "Safe skill");
  expect(() =>
    importProjectSkill("work", "safe-import", lock, "escaped")
  ).toThrow(ValueError);
  rmSync(project, { recursive: true });
  expect(() => importProjectSkill("work", "linked", lock)).toThrow("missing");
});

test("project import API returns Draft details and validates duplicate and category errors", async () => {
  registerProject("work", project);
  write(copyPath("local"), "---\ndescription: Local\n---\nSkill");
  const app = createProjectRoutes();
  const request = (skill: string, category: unknown) =>
    app.request(`/work/skills/${skill}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
  expect((await request("local", 7)).status).toBe(400);
  expect((await request("local", "../escape")).status).toBe(400);
  expect((await request("missing", "team")).status).toBe(400);
  const result = await request("local", "team");
  expect(result.status).toBe(200);
  expect((await result.json()).importedDraft).toMatchObject({
    name: "local",
    category: "team",
  });
  expect((await request("local", "other")).status).toBe(409);
});

test("import respects Catalog auto-commit without committing the project", () => {
  registerProject("work", project);
  write(copyPath("local"), "Project skill");
  const catalog = join(root, "catalog");
  const git = (cwd: string, args: string[]) =>
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Skill Loom Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ],
      { cwd }
    );
  expect(git(catalog, ["init", "-q"]).exitCode).toBe(0);
  expect(git(project, ["init", "-q"]).exitCode).toBe(0);
  expect(
    git(catalog, [
      "add",
      "--",
      "skills.lock.json",
      "skills",
      "shared-decks",
      "project-decks",
    ]).exitCode
  ).toBe(0);
  expect(git(catalog, ["commit", "-qm", "fixture"]).exitCode).toBe(0);
  const before = git(project, ["status", "--porcelain"]).stdout.toString();
  process.env.MY_SKILLS_AUTO_COMMIT = "1";
  const result = importProjectSkill("work", "local", lock);
  expect(result.message).not.toContain("失敗");
  expect(git(catalog, ["status", "--porcelain"]).stdout.toString()).toBe("");
  expect(
    git(catalog, [
      "ls-files",
      "drafts/skills/imported/local/SKILL.md",
    ]).stdout.toString()
  ).toContain("local/SKILL.md");
  expect(git(project, ["status", "--porcelain"]).stdout.toString()).toBe(
    before
  );
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

test("パスのみ登録・一覧・解除はプロジェクトを変更しない", () => {
  expect(listProjects()).toEqual([]);
  registerProject("work", project);
  expect(projectStatus("work", lock).skills).toEqual([]);
  expect(() => syncProject("work", lock)).toThrow("no deck");
  expect(() => registerProject("work", project)).toThrow(AlreadyExistsError);
  expect(() => registerProject("other", project)).toThrow(AlreadyExistsError);
  expect(listProjects()).toHaveLength(1);
  projectSkillAction("work", "alpha", "install", lock);
  unregisterProject("work");
  expect(existsSync(copyPath())).toBe(true);
  expect(listProjects()).toEqual([]);
});

test("継承付きデッキをコピーし Core とグローバルを変更しない", () => {
  write(join(root, "catalog/shared-decks/parent.json"), '{"skills":["alpha"]}');
  deck([]);
  const global = join(root, "runtime/active/alpha/SKILL.md");
  write(global, "global");
  registerProject("work", project, "work");
  expect(syncProject("work", lock, { dryRun: true }).plan).toEqual([
    { name: "alpha", action: "add" },
  ]);
  expect(existsSync(join(project, ".agents"))).toBe(false);
  const result = syncProject("work", lock);
  expect(result.skills.map((s) => s.name)).toEqual(["alpha"]);
  expect(result.skills[0]).toMatchObject({
    state: "managed",
    displayName: "alpha",
    description: "original",
    globalActive: true,
  });
  expect(readlinkSync(join(project, ".claude/skills/alpha"))).toBe(
    "../../.agents/skills/alpha"
  );
  expect(readFileSync(global, "utf8")).toBe("global");
  expect(existsSync(join(root, "runtime/archive"))).toBe(false);
  expect(existsSync(join(root, "runtime/lock.json"))).toBe(false);
});

test("ソース変更を更新しデッキから外れた管理スキルだけ削除", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  source("alpha", "changed");
  expect(syncProject("work", lock).plan[0]?.action).toBe("update");
  expect(readFileSync(copyPath(), "utf8")).toContain("changed");
  write(
    join(project, ".claude/skills/local/SKILL.md"),
    "---\nname: local\ndescription: local only\n---"
  );
  deck([]);
  expect(syncProject("work", lock).plan[0]?.action).toBe("remove");
  expect(existsSync(copyPath())).toBe(false);
  expect(projectStatus("work", lock).skills[0]).toMatchObject({
    name: "local",
    state: "unmanaged",
    inventory: false,
    description: "local only",
  });
});

test("drift は更新と削除を止め force で明示的に適用", () => {
  registerProject("work", project, "work");
  syncProject("work", lock);
  write(copyPath(), "local edit");
  source("alpha", "upstream");
  expect(projectStatus("work", lock).skills[0]?.state).toBe("drifted");
  expect(syncProject("work", lock).plan[0]).toMatchObject({
    action: "skip",
    reason: "drifted",
  });
  expect(() => projectSkillAction("work", "alpha", "update", lock)).toThrow(
    "drifted"
  );
  const preview = previewProjectSkill("work", "alpha", lock);
  expect(preview.diff).toContain("-local edit");
  expect(preview.diff).toContain("+upstream");
  expect(() =>
    projectSkillAction("work", "alpha", "update", lock, true, "stale")
  ).toThrow("Review");
  forceSync();
  expect(readFileSync(copyPath(), "utf8")).toContain("upstream");
  write(copyPath(), "another edit");
  deck([]);
  expect(syncProject("work", lock).plan[0]?.reason).toBe("drifted");
  forceSync();
  expect(existsSync(copyPath())).toBe(false);
});

test("未管理の衝突は force 同期でも保持し明示 update だけが採用する", () => {
  write(join(project, ".claude/skills/alpha/SKILL.md"), "existing");
  registerProject("work", project, "work");
  expect(projectStatus("work", lock).skills[0]?.state).toBe("conflict");
  expect(syncProject("work", lock, { force: true }).plan[0]?.reason).toBe(
    "unmanaged conflict"
  );
  expect(() => projectSkillAction("work", "alpha", "install", lock)).toThrow(
    AlreadyExistsError
  );
  expect(() => projectSkillAction("work", "alpha", "update", lock)).toThrow(
    "Review"
  );
  projectSkillAction(
    "work",
    "alpha",
    "update",
    lock,
    true,
    previewProjectSkill("work", "alpha", lock).revision
  );
  expect(projectStatus("work", lock).skills[0]?.managed).toBe(true);
  projectSkillAction("work", "alpha", "remove", lock);
  expect(existsSync(copyPath())).toBe(false);
  write(join(project, ".claude/skills/local/SKILL.md"), "local");
  expect(() => projectSkillAction("work", "local", "update", lock)).toThrow(
    "Unavailable"
  );
  projectSkillAction("work", "local", "remove", lock);
  expect(projectStatus("work", lock).skills[0]).toMatchObject({
    name: "alpha",
    state: "missing",
    managed: false,
    inventory: true,
    available: true,
    locations: [],
  });
});

test("External は Catalog 優先で Active にフォールバックし unavailable を報告", () => {
  lock.external = { ext: { localRepoPath: "external/ext" }, absent: {} };
  write(join(root, "runtime/active/ext/SKILL.md"), "active");
  deck(["ext", "absent"]);
  registerProject("work", project, "work");
  const result = syncProject("work", lock);
  expect(readFileSync(copyPath("ext"), "utf8")).toBe("active");
  expect(result.skills.find((s) => s.name === "absent")?.state).toBe(
    "unavailable"
  );
  expect(result.plan.find((s) => s.name === "absent")?.reason).toBe(
    "unavailable"
  );
  write(join(root, "catalog/external/ext/SKILL.md"), "catalog");
  syncProject("work", lock);
  expect(readFileSync(copyPath("ext"), "utf8")).toBe("catalog");
});

test("Vendor をコピーし欠落した管理スキルを再インストール", () => {
  lock.vendor = { vendor: {} };
  write(join(root, "catalog/vendor/vendor/SKILL.md"), "vendor");
  deck(["vendor"]);
  registerProject("work", project, "work");
  syncProject("work", lock);
  expect(readFileSync(copyPath("vendor"), "utf8")).toBe("vendor");
  rmSync(join(project, ".agents/skills/vendor"), { recursive: true });
  rmSync(join(project, ".claude/skills/vendor"));
  expect(projectStatus("work", lock).skills[0]?.state).toBe("missing");
  syncProject("work", lock);
  expect(existsSync(copyPath("vendor"))).toBe(true);
});

test("名前・ルート・祖先 symlink・manifest による境界逸脱を拒否", () => {
  expect(() => registerProject("../escape", project)).toThrow(ValueError);
  expect(() => registerProject("work", "relative")).toThrow(ValueError);
  expect(() => registerProject("work", join(root, "missing"))).toThrow(
    ValueError
  );
  symlinkSync(join(root, "runtime"), join(project, ".agents"));
  expect(() => registerProject("work", project)).toThrow(ValueError);
  rmSync(join(project, ".agents"));
  registerProject("work", project);
  expect(() =>
    projectSkillAction("work", "../escape", "install", lock)
  ).toThrow(ValueError);
  write(
    join(project, ".agents/skill-loom.json"),
    '{"version":1,"skills":{"../escape":{"source":"custom","hash":"bad"}}}'
  );
  expect(() => projectStatus("work", lock)).toThrow(ValueError);
});

test("Catalog 逸脱とコピー内 symlink を拒否し既存ファイルを残す", () => {
  registerProject("work", project);
  lock.custom!.skills!.alpha = { repoPath: "../outside" };
  expect(() => projectSkillAction("work", "alpha", "install", lock)).toThrow(
    ValueError
  );
  lock.custom!.skills!.alpha = { repoPath: "skills/dev/alpha" };
  symlinkSync(
    join(root, "catalog/skills.lock.json"),
    join(root, "catalog/skills/dev/alpha/link")
  );
  expect(() => projectSkillAction("work", "alpha", "install", lock)).toThrow(
    ValueError
  );
  expect(existsSync(copyPath())).toBe(false);
});

test("プロジェクト外リンクは内容を読まず明示 remove もリンク先を削除しない", () => {
  registerProject("work", project);
  write(join(root, "outside/SKILL.md"), "secret");
  mkdirSync(join(project, ".claude/skills"), { recursive: true });
  symlinkSync(join(root, "outside"), join(project, ".claude/skills/outside"));
  expect(projectStatus("work", lock).skills[0]).toMatchObject({
    state: "conflict",
    description: "",
  });
  projectSkillAction("work", "outside", "remove", lock);
  expect(readFileSync(join(root, "outside/SKILL.md"), "utf8")).toBe("secret");
});

test("API の登録・閲覧・同期・個別操作とエラー", async () => {
  const app = createProjectRoutes();
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(await (await app.request("/")).json()).toMatchObject({ projects: [] });
  expect((await post("/", { name: "work", path: project })).status).toBe(201);
  expect((await post("/", { name: "work", path: project })).status).toBe(409);
  expect((await post("/", {})).status).toBe(400);
  expect((await post("/work/sync", {})).status).toBe(400);
  expect((await post("/work/skills/alpha/install", {})).status).toBe(200);
  expect((await app.request("/work")).status).toBe(200);
  expect((await post("/work/skills/alpha/remove", {})).status).toBe(400);
  expect(
    (await post("/work/skills/alpha/remove", { confirm: true })).status
  ).toBe(200);
  expect((await app.request("/unknown")).status).toBe(400);
  expect((await app.request("/", { method: "POST", body: "{" })).status).toBe(
    400
  );
});

test("存在しなくなったパスも一覧に残り操作を拒否して登録解除できる", () => {
  registerProject("work", project, "work");
  rmSync(project, { recursive: true });
  expect(listProjects()).toHaveLength(1);
  expect(projectStatus("work", lock)).toMatchObject({
    state: "missing",
    skills: [],
    plan: [],
  });
  expect(() => projectSkillAction("work", "alpha", "install", lock)).toThrow(
    "missing"
  );
  expect(() => syncProject("work", lock)).toThrow("missing");
  unregisterProject("work");
  expect(listProjects()).toEqual([]);
});

test("Git のスキルパスの dirty 状態と Catalog のコミットを記録", () => {
  const git = (cwd: string, args: string[]) =>
    Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  git(project, ["init"]);
  const catalog = join(root, "catalog");
  git(catalog, ["init"]);
  git(catalog, ["add", "skills/dev/alpha/SKILL.md"]);
  expect(
    git(catalog, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "fixture",
    ]).exitCode
  ).toBe(0);
  registerProject("work", project);
  expect(projectStatus("work", lock).dirty).toBe(false);
  const result = projectSkillAction("work", "alpha", "install", lock);
  expect(result.dirty).toBe(true);
  expect(result.skills[0]?.sourceVersion).toMatch(/^[a-f0-9]{40}$/);
  expect(git(project, ["rev-parse", "--verify", "HEAD"]).exitCode).not.toBe(0);
});

test("採用 API は差分プレビューを返し古い確認を拒否", async () => {
  registerProject("work", project);
  write(copyPath(), "local");
  const app = createProjectRoutes();
  const update = (body: unknown) =>
    app.request("/work/skills/alpha/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await update({});
  expect(response.status).toBe(409);
  const { preview } = await response.json();
  expect(preview.diff).toContain("-local");
  write(copyPath(), "new local");
  expect(
    (await update({ force: true, confirm: true, revision: preview.revision }))
      .status
  ).toBe(409);
  const current = await (
    await app.request("/work/skills/alpha/preview")
  ).json();
  expect(
    (await update({ force: true, confirm: true, revision: current.revision }))
      .status
  ).toBe(200);
});
