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
import path from "node:path";
import process from "node:process";

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
    const installName =
      typeof meta?.installSkill === "string" ? meta.installSkill : name;
    const list = bySource.get(source) ?? [];
    list.push(installName);
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

function syncFrontmatterName(filePath: string, newName: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    return false;
  }

  let inFrontmatter = false;
  let replaced = false;
  const newLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      newLines.push(line);
      continue;
    }
    if (inFrontmatter && line.trim() === "---") {
      if (!replaced) {
        newLines.push(`name: ${newName}`);
        replaced = true;
      }
      inFrontmatter = false;
      newLines.push(line);
      continue;
    }
    if (inFrontmatter && /^name\s*:\s*.*$/.test(line)) {
      newLines.push(`name: ${newName}`);
      replaced = true;
      continue;
    }
    newLines.push(line);
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, newLines.join("\n"));
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function adjustAliasedSkills(lockPath: string): void {
  let lock: { external?: Record<string, ExternalSkillMeta> };
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      external?: Record<string, ExternalSkillMeta>;
    };
  } catch {
    return;
  }

  const activeDir =
    process.env.MY_SKILLS_ACTIVE_DIR ??
    (process.env.HOME ? path.join(process.env.HOME, ".agents", "skills") : "");
  if (!activeDir || !fs.existsSync(activeDir)) {
    return;
  }

  for (const [name, meta] of Object.entries(lock.external ?? {})) {
    const installSkill =
      typeof meta?.installSkill === "string" ? meta.installSkill : undefined;
    if (installSkill && installSkill !== name) {
      const srcDir = path.join(activeDir, installSkill);
      const dstDir = path.join(activeDir, name);
      if (fs.existsSync(srcDir)) {
        if (fs.existsSync(dstDir)) {
          fs.rmSync(dstDir, { recursive: true, force: true });
        }
        fs.renameSync(srcDir, dstDir);
        const skillMd = path.join(dstDir, "SKILL.md");
        syncFrontmatterName(skillMd, name);
      }
    }
  }
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
  for (const plan of plans) {
    const args = buildArgs(plan.source, plan.skills);
    const display = ["npx", ...args].map(shellQuote).join(" ");
    process.stdout.write(`${display}\n`);
    if (!install) continue;

    const result = Bun.spawnSync(["npx", ...args], {
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((result.exitCode ?? 1) !== 0) {
      process.exit(result.exitCode ?? 1);
    }
  }

  if (install) {
    adjustAliasedSkills(lockPath);
  }
}

if (import.meta.main) {
  main();
}
