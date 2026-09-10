#!/usr/bin/env bun
/**
 * restore-lock — skills.lock.json に基づいて外部スキルをインストールする（TypeScript 版）
 *
 * 既定: 表示用コマンド行を stdout に出す（dry-run / ログ向け。値は shell クォート済み）。
 * --install: npx を引数配列で直接実行し、shell 経由の注入を避ける。
 *
 * 使い方:
 *   bun restore-lock.ts LOCK_FILE
 *   bun restore-lock.ts --install LOCK_FILE
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { syncSkillMdName } from "../../../../app/backend/domain/skillMd";

interface ExternalSkillMeta {
  source?: unknown;
  installSkill?: unknown;
}

const FLAGS = [
  "-g",
  "-a",
  "claude-code",
  "-a",
  "codex",
  "-a",
  "antigravity",
  "-y",
] as const;

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function loadPlans(
  lockPath: string
): Array<{ source: string; skills: string[] }> {
  let lock: { external?: Record<string, ExternalSkillMeta> };
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      external?: Record<string, ExternalSkillMeta>;
    };
  } catch {
    console.error(`Error: Cannot read or parse lock file: ${lockPath}`);
    process.exit(1);
  }

  const bySource = new Map<string, string[]>();
  for (const [name, meta] of Object.entries(lock.external ?? {})) {
    const source = meta?.source;
    if (typeof source !== "string" || source === "") {
      console.error(
        `Warning: skipping external skill '${name}': missing source`
      );
      continue;
    }
    const list = bySource.get(source) ?? [];
    list.push(name);
    bySource.set(source, list);
  }

  return [...bySource.keys()].sort().map((source) => ({
    source,
    skills: [...new Set(bySource.get(source) ?? [])].sort(),
  }));
}

function buildArgs(source: string, skills: string[]): string[] {
  const skillArgs = skills.flatMap((skill) => ["--skill", skill]);
  return ["skills", "add", source, ...skillArgs, ...FLAGS];
}

function resolveActiveDir(): string {
  return (
    process.env.MY_SKILLS_ACTIVE_DIR ??
    (process.env.HOME ? path.join(process.env.HOME, ".agents", "skills") : "")
  );
}

function agentSkillDirs(): string[] {
  const home = process.env.HOME ?? os.homedir();
  return [
    process.env.MY_SKILLS_CLAUDE_SKILLS_DIR ??
      path.join(home, ".claude", "skills"),
    process.env.MY_SKILLS_GEMINI_SKILLS_DIR ??
      path.join(home, ".gemini", "config", "skills"),
  ];
}

function unlinkAgentSkill(name: string): void {
  for (const dir of agentSkillDirs()) {
    const link = path.join(dir, name);
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {
      /* missing */
    }
  }
}

function linkAgentSkill(activeDir: string, name: string): void {
  const target = path.join(activeDir, name);
  if (!fs.existsSync(target)) return;
  for (const dir of agentSkillDirs()) {
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      fs.unlinkSync(link);
    } catch {
      /* missing */
    }
    fs.symlinkSync(path.relative(dir, target), link);
  }
}

function moveDir(src: string, dst: string): void {
  fs.renameSync(src, dst);
}

function pathPresent(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function withStashedUpstream(
  activeDir: string,
  installSkill: string,
  fn: () => void
): void {
  const srcDir = path.join(activeDir, installSkill);
  if (!pathPresent(srcDir)) {
    fn();
    return;
  }
  const stashDir = fs.mkdtempSync(path.join(activeDir, ".skill-loom-stash-"));
  const stashPath = path.join(stashDir, installSkill);
  moveDir(srcDir, stashPath);
  try {
    unlinkAgentSkill(installSkill);
    fn();
  } finally {
    if (pathPresent(stashPath)) {
      const restored = path.join(activeDir, installSkill);
      if (pathPresent(restored)) {
        fs.rmSync(restored, { recursive: true, force: true });
      }
      moveDir(stashPath, restored);
      linkAgentSkill(activeDir, installSkill);
    }
    fs.rmSync(stashDir, { recursive: true, force: true });
  }
}

function placeAliasedSkill(
  activeDir: string,
  deployName: string,
  installSkill: string
): void {
  const srcDir = path.join(activeDir, installSkill);
  const dstDir = path.join(activeDir, deployName);
  if (!pathPresent(srcDir)) return;
  unlinkAgentSkill(installSkill);
  if (pathPresent(dstDir)) {
    fs.rmSync(dstDir, { recursive: true, force: true });
  }
  moveDir(srcDir, dstDir);
  syncSkillMdName(path.join(dstDir, "SKILL.md"), deployName);
  linkAgentSkill(activeDir, deployName);
}

function aliasedJobs(
  lockPath: string
): Array<{ source: string; deployName: string; installSkill: string }> {
  let lock: { external?: Record<string, ExternalSkillMeta> };
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      external?: Record<string, ExternalSkillMeta>;
    };
  } catch {
    return [];
  }
  const jobs: Array<{
    source: string;
    deployName: string;
    installSkill: string;
  }> = [];
  for (const [name, meta] of Object.entries(lock.external ?? {})) {
    const source = meta?.source;
    const installSkill =
      typeof meta?.installSkill === "string" ? meta.installSkill : undefined;
    if (typeof source !== "string" || source === "") continue;
    if (installSkill && installSkill !== name) {
      jobs.push({ source, deployName: name, installSkill });
    }
  }
  return jobs;
}

function main(): void {
  const argv = process.argv.slice(2);
  const install = argv[0] === "--install";
  const lockPath = install ? argv[1] : argv[0];
  if (lockPath === undefined) {
    console.error("Error: restore-lock requires LOCK_FILE");
    process.exit(2);
  }

  const plans = loadPlans(lockPath);
  const aliased = aliasedJobs(lockPath);
  const aliasedKeys = new Set(
    aliased.map((job) => `${job.source}\0${job.deployName}`)
  );

  for (const plan of plans) {
    const standard = plan.skills.filter(
      (skill) => !aliasedKeys.has(`${plan.source}\0${skill}`)
    );
    if (standard.length > 0) {
      const args = buildArgs(plan.source, standard);
      const display = ["npx", ...args].map(shellQuote).join(" ");
      process.stdout.write(`${display}\n`);
      if (install) {
        const result = Bun.spawnSync(["npx", ...args], {
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((result.exitCode ?? 1) !== 0) {
          process.exit(result.exitCode ?? 1);
        }
      }
    }
    for (const job of aliased.filter((row) => row.source === plan.source)) {
      const args = buildArgs(job.source, [job.installSkill]);
      const display = ["npx", ...args].map(shellQuote).join(" ");
      process.stdout.write(`${display}\n`);
      if (!install) continue;
      const activeDir = resolveActiveDir();
      if (!activeDir) continue;
      let failed = 0;
      withStashedUpstream(activeDir, job.installSkill, () => {
        const result = Bun.spawnSync(["npx", ...args], {
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((result.exitCode ?? 1) !== 0) {
          failed = result.exitCode ?? 1;
          return;
        }
        placeAliasedSkill(activeDir, job.deployName, job.installSkill);
      });
      if (failed !== 0) process.exit(failed);
    }
  }
}

if (import.meta.main) {
  main();
}
