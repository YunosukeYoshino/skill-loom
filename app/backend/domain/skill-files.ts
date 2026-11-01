import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillFile } from "../../shared/skill-workspace-types";
import { ValueError } from "./errors";

export const SKILL_TEXT_LIMIT = 1024 * 1024;

export function assertSkillName(name: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new ValueError("Invalid skill name");
}

/** 閲覧・編集・コピーの全入口で同じ境界を使う。symlink は追跡しない。 */
export function skillFilePath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    /[\\\0]/.test(path) ||
    path.split("/").some((p) => p === ".." || p.toLowerCase() === ".git")
  )
    throw new ValueError("Skill path must stay within the skill directory");
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ValueError("Skill path must stay within the skill directory");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new ValueError("Symlinks are not supported inside skills");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export function listSkillFiles(root: string): SkillFile[] {
  const files: SkillFile[] = [];
  let total = 0;
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === ".git") continue;
      const path = relative(root, join(dir, entry.name)).split(sep).join("/");
      const absolute = skillFilePath(root, path);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        total += stat.size;
        if (files.length >= 2000 || total > 50 * SKILL_TEXT_LIMIT)
          throw new ValueError("Skill exceeds the 2000 file / 50 MiB limit");
        const data = readFileSync(absolute).subarray(0, 8192);
        let binary = data.includes(0);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(data, {
            stream: true,
          });
        } catch {
          binary = true;
        }
        files.push({ path, size: stat.size, binary });
      } else throw new ValueError(`Unsupported skill file: ${path}`);
    }
  }
  walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function skillTreeHash(root: string): string {
  const hash = createHash("sha256");
  if (!existsSync(root)) return "missing";
  for (const file of listSkillFiles(root)) {
    const path = skillFilePath(root, file.path);
    hash
      .update(file.path)
      .update("\0")
      .update(String(lstatSync(path).mode & 0o111))
      .update("\0")
      .update(readFileSync(path))
      .update("\0");
  }
  return hash.digest("hex");
}

export function copySkillTree(source: string, target: string): void {
  const files = listSkillFiles(source);
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    const from = skillFilePath(source, file.path);
    const to = skillFilePath(target, file.path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { dereference: false });
    chmodSync(to, (lstatSync(from).mode & 0o777) | 0o600);
  }
}

export function writeSkillJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}
