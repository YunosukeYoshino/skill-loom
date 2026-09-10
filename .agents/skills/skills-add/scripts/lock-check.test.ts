import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "lock-check.ts");

function run(args: string[]): {
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

describe("lock-check lookup", () => {
  test("セクションと external の source を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-check-"));
    const lockFile = path.join(dir, "skills.lock.json");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        custom: { skills: { mine: { repoPath: "custom/mine" } } },
        vendor: { forked: { source: "old/repo" } },
        external: {
          search: { source: "first-owner/search-repo" },
        },
      })
    );

    expect(run(["lookup", "mine", lockFile]).stdout.trim()).toBe("custom");
    expect(run(["lookup", "forked", lockFile]).stdout.trim()).toBe("vendor");
    expect(run(["lookup", "search", lockFile]).stdout.trim()).toBe(
      "external first-owner/search-repo"
    );
    expect(run(["lookup", "missing", lockFile]).stdout.trim()).toBe("none");
    expect(run(["in-lock", "search", lockFile]).stdout.trim()).toBe("yes");
    expect(run(["in-lock", "missing", lockFile]).stdout.trim()).toBe("no");
  });
});
