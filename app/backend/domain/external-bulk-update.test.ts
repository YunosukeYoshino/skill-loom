/**
 * External Skill の一括更新。偽の上流 repo（一時ディレクトリの git repo）と偽の skills CLI で、
 * 計画が何も書かないこと、成功した分だけピンが進むこと、vendor と失敗した分が動かないことを確かめる。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applyExternalBulkUpdate,
  externalBulkUpdateExitCode,
  planExternalBulkUpdate,
  type BulkUpdateSkillOutcome,
  type ExternalBulkUpdatePlan,
} from "./external-bulk-update";
import type { Lock } from "./inventory";

let sandbox: string;
const touched: string[] = [];
const dir = (...parts: string[]) => join(sandbox, ...parts);

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
];

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !GIT_ENV_OVERRIDES.includes(key))
      env[key] = value;
  return env;
}

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      repo,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", env: gitEnv() }
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function upstreamRepo(source: string): string {
  return dir("upstream", source);
}

function writeSkill(
  source: string,
  name: string,
  body: string,
  extra: Record<string, string> = {}
): void {
  const skillDir = join(upstreamRepo(source), "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\n${body}\n`
  );
  for (const [path, content] of Object.entries(extra)) {
    mkdirSync(join(skillDir, path, ".."), { recursive: true });
    writeFileSync(join(skillDir, path), content);
  }
}

function commit(source: string, message: string): string {
  const repo = upstreamRepo(source);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function initRepo(source: string): void {
  mkdirSync(upstreamRepo(source), { recursive: true });
  git(upstreamRepo(source), "init", "-q", "-b", "main");
}

/**
 * skills CLI の `add <source> --skill <name>... -g -a ... -y` を真似る。上流 repo の HEAD を
 * 展開して CLI lock に tree SHA を書く。FAKE_FAIL_SOURCES は途中まで書いてから失敗し、
 * FAKE_SKIP_SKILLS は何もせず 0 で終わる（実 CLI が候補を黙って飛ばす挙動）。
 */
const FAKE_SKILLS_CLI = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
const argv = Bun.argv.slice(2);
appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(argv) + "\\n");
const source = argv[argv.indexOf("add") + 1];
const names = argv.flatMap((arg, i) => (argv[i - 1] === "--skill" ? [arg] : []));
const active = process.env.MY_SKILLS_ACTIVE_DIR;
const env = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
const repo = join(process.env.FAKE_UPSTREAM_ROOT, source);
const failing = (process.env.FAKE_FAIL_SOURCES ?? "").split(",");
if (failing.includes(source)) {
  writeFileSync(join(active, names[0], "SKILL.md"), "half-written\\n");
  console.error("simulated network failure");
  process.exit(1);
}
const skipped = (process.env.FAKE_SKIP_SKILLS ?? "").split(",");
const lockPath = process.env.MY_SKILLS_GLOBAL_LOCK_FILE;
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { version: 3, skills: {} };
for (const name of names) {
  if (skipped.includes(name)) continue;
  const path = "skills/" + name;
  const tree = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD:" + path], { env }).stdout.toString().trim();
  const tmp = mkdtempSync(join(process.env.FAKE_TMP, "extract-"));
  const archive = Bun.spawnSync(["git", "-C", repo, "archive", "HEAD", path], { env });
  Bun.spawnSync(["tar", "-x", "-C", tmp], { stdin: archive.stdout });
  rmSync(join(active, name), { recursive: true, force: true });
  mkdirSync(active, { recursive: true });
  renameSync(join(tmp, path), join(active, name));
  lock.skills[name] = { source, sourceType: "github", sourceUrl: "https://github.com/" + source + ".git", skillPath: path + "/SKILL.md", skillFolderHash: tree };
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2));
`;

const TRASH_STUB =
  '#!/usr/bin/env bash\nset -euo pipefail\nfor path in "$@"; do mv -- "$path" "$path.trashed-$RANDOM"; done\n';

type Commits = { oneV1: string; oneV2: string; threeV1: string };

let commits: Commits;

function readPins(): {
  external: Record<string, { commit: string; sourceUrl?: string }>;
  vendor: Record<string, { commit: string }>;
} {
  return JSON.parse(readFileSync(dir("skills.lock.pins.json"), "utf8"));
}

function pinCommits(): Record<string, string> {
  const pins = readPins();
  return Object.fromEntries(
    Object.entries(pins.external).map(([name, pin]) => [name, pin.commit])
  );
}

function installedBody(name: string): string {
  return readFileSync(dir("active", name, "SKILL.md"), "utf8");
}

function runFakeCli(source: string, names: string[]): void {
  const args = [dir("fake-skills"), "skills@1.7.6", "add", source];
  for (const name of names) args.push("--skill", name);
  const result = Bun.spawnSync(args, { stderr: "pipe", env: gitEnv() });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

const sourceUrl = (source: string) => `file://${upstreamRepo(source)}`;

function buildLock(): Lock {
  const entry = (source: string, name: string) => ({
    source,
    sourceUrl: sourceUrl(source),
    skillPath: `skills/${name}/SKILL.md`,
  });
  return {
    version: 1,
    external: {
      alpha: entry("fake/one", "alpha"),
      beta: entry("fake/one", "beta"),
      delta: entry("fake/one", "delta"),
      tool: entry("fake/one", "tool"),
      vend: entry("fake/one", "vend"),
      "json-render": { ...entry("fake/one", "react"), installSkill: "react" },
      gone: {
        source: "fake/two",
        sourceUrl: `file://${dir("upstream", "fake", "missing-repo")}`,
        skillPath: "skills/gone/SKILL.md",
      },
      omega: entry("fake/three", "omega"),
    },
    vendor: {
      vend: {
        source: "fake/one",
        sourceUrl: sourceUrl("fake/one"),
        skillPath: "skills/vend/SKILL.md",
      },
    },
  };
}

function writePins(lock: Lock): void {
  const pin = (commit: string, url: string | undefined) => ({
    sourceUrl: url,
    commit,
    ref: "HEAD",
    resolvedAt: "2026-11-01T00:00:00Z",
  });
  const external: Record<string, unknown> = {};
  for (const [name, meta] of Object.entries(lock.external ?? {})) {
    const commit =
      meta.source === "fake/one"
        ? commits.oneV1
        : meta.source === "fake/three"
          ? commits.threeV1
          : "0123456789abcdef0123456789abcdef01234567";
    external[name] = pin(commit, meta.sourceUrl);
  }
  writeFileSync(
    dir("skills.lock.pins.json"),
    `${JSON.stringify(
      {
        external,
        vendor: { vend: pin(commits.oneV1, sourceUrl("fake/one")) },
      },
      null,
      2
    )}\n`
  );
}

/** 一時ディレクトリの中身を path → 内容で写す。dry-run が何も書かないことの比較に使う。 */
function snapshot(root: string, skip: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const rel = relative(root, full);
      if (skip.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`)))
        continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "skill-loom-bulk-update-"));
  for (const sub of [
    "active",
    "archive",
    "claude-skills",
    "gemini-skills",
    "tmp",
  ])
    mkdirSync(dir(sub), { recursive: true });
  writeFileSync(dir("fake-skills"), FAKE_SKILLS_CLI);
  chmodSync(dir("fake-skills"), 0o755);
  writeFileSync(dir("trash-stub"), TRASH_STUB);
  chmodSync(dir("trash-stub"), 0o755);
  writeFileSync(dir("cli.log"), "");
  setEnv("MY_SKILLS_ACTIVE_DIR", dir("active"));
  setEnv("MY_SKILLS_ARCHIVE_DIR", dir("archive"));
  setEnv("MY_SKILLS_CLAUDE_SKILLS_DIR", dir("claude-skills"));
  setEnv("MY_SKILLS_GEMINI_SKILLS_DIR", dir("gemini-skills"));
  setEnv("MY_SKILLS_GLOBAL_LOCK_FILE", dir("cli-lock.json"));
  setEnv("MY_SKILLS_IGNORE_FILE", dir("ignore.json"));
  setEnv("MY_SKILLS_LOCK_FILE", dir("skills.lock.json"));
  setEnv("MY_SKILLS_LOCK_PINS_FILE", dir("skills.lock.pins.json"));
  setEnv("MY_SKILLS_ADD_BIN", dir("fake-skills"));
  setEnv("MY_SKILLS_UPDATE_BIN", dir("fake-skills"));
  setEnv("MY_SKILLS_TRASH_BIN", dir("trash-stub"));
  setEnv("MY_SKILLS_AUTO_COMMIT", "0");
  setEnv("FAKE_UPSTREAM_ROOT", dir("upstream"));
  setEnv("FAKE_CLI_LOG", dir("cli.log"));
  setEnv("FAKE_TMP", dir("tmp"));
  setEnv("FAKE_FAIL_SOURCES", "");
  setEnv("FAKE_SKIP_SKILLS", "");

  initRepo("fake/one");
  for (const name of ["alpha", "beta", "delta", "vend", "react"])
    writeSkill("fake/one", name, `${name} v1`);
  writeSkill("fake/one", "tool", "tool v1", { "scripts/run.sh": "echo v1\n" });
  const oneV1 = commit("fake/one", "v1");
  initRepo("fake/three");
  writeSkill("fake/three", "omega", "omega v1");
  const threeV1 = commit("fake/three", "v1");
  commits = { oneV1, threeV1, oneV2: "" };

  runFakeCli("fake/one", ["alpha", "beta", "delta", "tool", "react"]);
  renameSync(dir("active", "react"), dir("active", "json-render"));
  writeFileSync(
    dir("active", "json-render", "SKILL.md"),
    installedBody("json-render").replace("name: react", "name: json-render")
  );
  runFakeCli("fake/three", ["omega"]);
  mkdirSync(dir("active", "vend"));
  writeFileSync(dir("active", "vend", "SKILL.md"), "vendor override\n");
  mkdirSync(dir("active", "gone"));
  writeFileSync(dir("active", "gone", "SKILL.md"), "gone v1\n");

  for (const name of ["alpha", "delta", "vend", "react"])
    writeSkill("fake/one", name, `${name} v2`);
  writeSkill("fake/one", "tool", "tool v2", { "scripts/run.sh": "echo v2\n" });
  writeSkill("fake/three", "omega", "omega v2");
  commits.oneV2 = commit("fake/one", "v2");
  commit("fake/three", "v2");

  const lock = buildLock();
  writeFileSync(dir("skills.lock.json"), JSON.stringify(lock, null, 2));
  writePins(lock);
  writeFileSync(dir("cli.log"), "");
});

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  rmSync(sandbox, { recursive: true, force: true });
});

function skillEntry(plan: ExternalBulkUpdatePlan, name: string) {
  for (const source of plan.sources)
    for (const skill of source.skills) if (skill.name === name) return skill;
  throw new Error(`no plan entry for ${name}`);
}

function outcomeOf(
  outcomes: BulkUpdateSkillOutcome[],
  name: string
): BulkUpdateSkillOutcome {
  const found = outcomes.find((outcome) => outcome.name === name);
  if (!found) throw new Error(`no outcome for ${name}`);
  return found;
}

describe("planExternalBulkUpdate", () => {
  test("更新される skill、ピンから HEAD までの範囲、変わるファイルを出す", async () => {
    const session = await planExternalBulkUpdate(buildLock());
    try {
      const plan = session.plan;
      const alpha = skillEntry(plan, "alpha");
      expect(alpha).toMatchObject({
        state: "update",
        pin: commits.oneV1,
        head: commits.oneV2,
        commits: 1,
        files: [{ status: "M", path: "skills/alpha/SKILL.md" }],
        risky: [],
      });
      expect(skillEntry(plan, "beta").state).toBe("current");
      expect(skillEntry(plan, "json-render")).toMatchObject({
        state: "update",
        upstreamName: "react",
        aliased: true,
      });
      expect(skillEntry(plan, "tool")).toMatchObject({
        state: "update",
        risky: ["skills/tool/scripts/run.sh"],
      });
      expect(skillEntry(plan, "gone")).toMatchObject({
        state: "failed",
        failure: { kind: "fetch" },
      });
      const one = plan.sources.find((row) => row.source === "fake/one");
      expect(one?.head).toBe(commits.oneV2);
      expect(one?.pins).toEqual([commits.oneV1]);
    } finally {
      session.dispose();
    }
  });

  test("vendor が上書きしている skill は上流が変わっても更新対象にしない", async () => {
    const session = await planExternalBulkUpdate(buildLock());
    try {
      expect(skillEntry(session.plan, "vend")).toEqual({
        name: "vend",
        state: "skipped",
        reason: "vendor",
      });
    } finally {
      session.dispose();
    }
  });

  test("計画は Catalog・Projection・CLI lock のどれも書かない", async () => {
    const before = snapshot(sandbox, ["upstream", "tmp"]);
    const session = await planExternalBulkUpdate(buildLock());
    session.dispose();
    expect(snapshot(sandbox, ["upstream", "tmp"])).toEqual(before);
    expect(readFileSync(dir("cli.log"), "utf8")).toBe("");
  });
});

describe("applyExternalBulkUpdate", () => {
  test("成功した分だけピンと中身が進み、vendor・保留・失敗した分は元のまま", async () => {
    setEnv("FAKE_FAIL_SOURCES", "fake/three");
    setEnv("FAKE_SKIP_SKILLS", "delta");
    const pinsBefore = pinCommits();
    const vendorPinBefore = readPins().vendor;
    const session = await planExternalBulkUpdate(buildLock());
    let outcomes: BulkUpdateSkillOutcome[];
    try {
      outcomes = applyExternalBulkUpdate(session, buildLock());
    } finally {
      session.dispose();
    }

    const pinsAfter = pinCommits();
    const moved = Object.keys(pinsAfter).filter(
      (name) => pinsAfter[name] !== pinsBefore[name]
    );
    expect(moved.sort()).toEqual(["alpha", "json-render"]);
    expect(pinsAfter.alpha).toBe(commits.oneV2);
    expect(readPins().vendor).toEqual(vendorPinBefore);

    expect(installedBody("alpha")).toContain("alpha v2");
    expect(installedBody("json-render")).toContain("react v2");
    expect(installedBody("json-render")).toContain("name: json-render");
    expect(installedBody("vend")).toBe("vendor override\n");
    expect(installedBody("delta")).toContain("delta v1");
    expect(installedBody("omega")).toContain("omega v1");
    expect(installedBody("tool")).toContain("tool v1");

    expect(outcomeOf(outcomes, "alpha").outcome).toBe("updated");
    expect(outcomeOf(outcomes, "tool")).toMatchObject({
      outcome: "held",
      reason: "risky",
    });
    expect(outcomeOf(outcomes, "delta")).toMatchObject({
      outcome: "failed",
      failure: { kind: "verify" },
    });
    expect(outcomeOf(outcomes, "omega")).toMatchObject({
      outcome: "failed",
      failure: { kind: "install" },
    });
    expect(outcomeOf(outcomes, "gone")).toMatchObject({
      outcome: "failed",
      failure: { kind: "fetch" },
    });
    expect(outcomes.some((outcome) => outcome.name === "vend")).toBe(false);
    expect(externalBulkUpdateExitCode(outcomes)).toBe(4 | 8 | 16 | 32);

    const cliCalls = readFileSync(dir("cli.log"), "utf8").trim().split("\n");
    expect(cliCalls.some((line) => line.includes('"vend"'))).toBe(false);
    const oneCalls = cliCalls.filter((line) => line.includes('"fake/one"'));
    expect(oneCalls.filter((line) => !line.includes('"react"'))).toHaveLength(
      1
    );
  });

  test("risky を許せばスクリプトが変わった skill も更新する", async () => {
    const session = await planExternalBulkUpdate(buildLock());
    let outcomes: BulkUpdateSkillOutcome[];
    try {
      outcomes = applyExternalBulkUpdate(session, buildLock(), {
        includeRisky: true,
      });
    } finally {
      session.dispose();
    }
    expect(outcomeOf(outcomes, "tool").outcome).toBe("updated");
    expect(pinCommits().tool).toBe(commits.oneV2);
    expect(readFileSync(dir("active", "tool", "scripts", "run.sh"), "utf8")).toBe(
      "echo v2\n"
    );
  });

  test("all-or-nothing では 1 件でも失敗すると成功した分も戻してピンを動かさない", async () => {
    setEnv("FAKE_SKIP_SKILLS", "delta");
    const pinsBefore = readFileSync(dir("skills.lock.pins.json"), "utf8");
    const session = await planExternalBulkUpdate(buildLock());
    let outcomes: BulkUpdateSkillOutcome[];
    try {
      outcomes = applyExternalBulkUpdate(session, buildLock(), {
        onFailure: "rollback-all",
      });
    } finally {
      session.dispose();
    }
    expect(readFileSync(dir("skills.lock.pins.json"), "utf8")).toBe(pinsBefore);
    expect(installedBody("alpha")).toContain("alpha v1");
    expect(outcomeOf(outcomes, "alpha")).toMatchObject({
      outcome: "failed",
      failure: { kind: "rolled-back" },
    });
  });

  test("書いたピンは lock_pins.py と同じ書式（キー順・sourceUrl 一致・UTC 秒）", async () => {
    const session = await planExternalBulkUpdate(buildLock());
    try {
      applyExternalBulkUpdate(session, buildLock());
    } finally {
      session.dispose();
    }
    const text = readFileSync(dir("skills.lock.pins.json"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    const pins = JSON.parse(text) as {
      external: Record<
        string,
        { sourceUrl: string; commit: string; ref: string; resolvedAt: string }
      >;
    };
    const names = Object.keys(pins.external);
    expect(names).toEqual([...names].sort());
    expect(Object.keys(pins.external.alpha ?? {})).toEqual([
      "sourceUrl",
      "commit",
      "ref",
      "resolvedAt",
    ]);
    expect(pins.external.alpha?.sourceUrl).toBe(sourceUrl("fake/one"));
    expect(pins.external.alpha?.ref).toBe("HEAD");
    expect(pins.external.alpha?.resolvedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    );
    expect(existsSync(dir("active", "alpha"))).toBe(true);
  });
});
