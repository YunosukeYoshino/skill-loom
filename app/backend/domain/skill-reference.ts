import type { SkillRef } from "../../shared/skill-workspace-types";
import { ValueError } from "./errors";
import { assertSkillName } from "./skill-files";

function checkedName(name: unknown): string {
  if (typeof name !== "string") throw new ValueError("Invalid skill reference");
  assertSkillName(name);
  return name;
}

function checkedSource(source: unknown): string | undefined {
  if (source === undefined) return undefined;
  if (typeof source !== "string")
    throw new ValueError("Invalid skill reference");
  if (
    source.length > 200 ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(source)
  )
    throw new ValueError("Source must be owner/repo");
  return source.toLowerCase();
}

function unsafePart(part: string): boolean {
  return (
    !part || part === "." || part === ".." || part.toLowerCase() === ".git"
  );
}

function checkedSourcePath(path: unknown): string | undefined {
  if (path === undefined) return undefined;
  if (typeof path !== "string") throw new ValueError("Invalid skill reference");
  const parts = path.split("/");
  if (
    parts.at(-1) !== "SKILL.md" ||
    /[\\\x00-\x1f\x7f:]/.test(path) ||
    parts.some(unsafePart)
  )
    throw new ValueError("Invalid source skill path");
  return path;
}

/** HTTP と保存済み metadata で同じ参照境界を使う。 */
export function checkedSkillRef(value: unknown): SkillRef {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValueError("Skill reference is required");
  const ref = value as Record<string, unknown>;
  const name = checkedName(ref.name);
  const source = checkedSource(ref.source);
  const skillPath = checkedSourcePath(ref.skillPath);
  return {
    name,
    ...(source ? { source } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
}
