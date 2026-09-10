import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "sync-skill-name.ts");

function runSync(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args]);
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("sync-skill-name", () => {
  test("frontmatter の name を新しい名前に書き換える", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-name-"));
    const skillMd = path.join(dir, "SKILL.md");
    fs.writeFileSync(
      skillMd,
      `---
name: old-name
description: A helpful skill
---

# Old Name
Body text
`
    );

    const out = runSync([skillMd, "new-namespaced-name"]);
    expect(out.exitCode).toBe(0);

    const updated = fs.readFileSync(skillMd, "utf-8");
    expect(updated).toContain("name: new-namespaced-name");
    expect(updated).toContain("description: A helpful skill");
    expect(updated).toContain("# Old Name");
  });

  test("クォート付きの name でも正しく書き換える", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-name-q-"));
    const skillMd = path.join(dir, "SKILL.md");
    fs.writeFileSync(
      skillMd,
      `---
name: "quoted-name"
description: Test
---
`
    );

    const out = runSync([skillMd, "replaced-name"]);
    expect(out.exitCode).toBe(0);

    const updated = fs.readFileSync(skillMd, "utf-8");
    expect(updated).toContain("name: replaced-name");
  });
});
