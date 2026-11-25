import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BulkUpdateSkillOutcome,
  type ExternalBulkUpdatePlan,
  planExternalBulkUpdate,
  type PlannedSkillUpdate,
} from "./domain/external-bulk-update";
import {
  applyExternalUpdatePlan,
  type BulkUpdateIo,
  type ExternalUpdateAllArgs,
  formatOutcomesText,
  formatPlanText,
  parseExternalUpdateAllArgs,
  planSummary,
  reportExternalUpdatePlan,
} from "./externalBulkUpdateCli";

const PIN = "a".repeat(40);
const HEAD = "b".repeat(40);

function update(overrides: Partial<PlannedSkillUpdate>): PlannedSkillUpdate {
  return {
    name: "alpha",
    state: "update",
    source: "fake/one",
    upstreamName: "alpha",
    aliased: false,
    skillPath: "skills/alpha/SKILL.md",
    pin: PIN,
    head: HEAD,
    headTree: "c".repeat(40),
    baseline: "installed",
    commits: 2,
    files: [{ status: "M", path: "skills/alpha/SKILL.md", mode: "100644" }],
    risky: [],
    ...overrides,
  };
}

const plan: ExternalBulkUpdatePlan = {
  sources: [
    {
      source: "fake/one",
      sourceUrl: "file:///fake/one",
      head: HEAD,
      pins: [PIN],
      skills: [
        update({}),
        update({
          name: "json-render",
          upstreamName: "react",
          aliased: true,
          commits: 1,
          files: null,
          baseline: "unknown",
          pin: null,
        }),
        update({
          name: "tool",
          files: [{ status: "M", path: "skills/tool/run.sh", mode: "100755" }],
          risky: ["skills/tool/run.sh"],
        }),
        { name: "vend", state: "skipped", reason: "vendor" },
        { name: "beta", state: "current" },
      ],
    },
    {
      source: "fake/two",
      sourceUrl: "file:///fake/two",
      head: null,
      pins: [],
      skills: [
        {
          name: "gone",
          state: "failed",
          failure: { kind: "fetch", message: "git clone failed" },
        },
      ],
    },
    {
      source: "fake/three",
      sourceUrl: "file:///fake/three",
      head: HEAD,
      pins: [HEAD],
      skills: [{ name: "omega", state: "current" }],
    },
  ],
};

const planOnly: ExternalUpdateAllArgs = {
  apply: false,
  yes: false,
  includeRisky: false,
  rollbackAll: false,
  source: null,
};

function recordingIo(json: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const confirms: boolean[] = [];
  const io: BulkUpdateIo = {
    json,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm: (yes) => {
      confirms.push(yes);
      return 0;
    },
    run: () => {
      throw new Error("an empty plan must not call the skills CLI");
    },
  };
  return { io, out, err, confirms };
}

describe("parseExternalUpdateAllArgs", () => {
  test("既定は計画だけ", () => {
    expect(parseExternalUpdateAllArgs(["--all"])).toEqual(planOnly);
  });

  test("適用のフラグと --source を読む", () => {
    expect(
      parseExternalUpdateAllArgs([
        "--all",
        "--source",
        "fake/one",
        "--apply",
        "--yes",
        "--include-risky",
        "--all-or-nothing",
        "--json",
      ])
    ).toEqual({
      apply: true,
      yes: true,
      includeRisky: true,
      rollbackAll: true,
      source: "fake/one",
    });
  });

  test("知らないフラグと値の無い --source は拒む", () => {
    expect(parseExternalUpdateAllArgs(["--all", "--force"])).toBeNull();
    expect(parseExternalUpdateAllArgs(["--all", "--source"])).toBeNull();
  });
});

describe("plan text", () => {
  test("範囲・別名・保留・vendor・失敗を書き分け、全部 current の source は 1 行にまとめる", () => {
    expect(formatPlanText(plan, false)).toEqual([
      "External update plan:",
      `fake/one  HEAD bbbbbbbbbbbb  pins: aaaaaaaaaaaa`,
      "  update   alpha  aaaaaaaaaaaa..bbbbbbbbbbbb (2 commits)",
      "      M skills/alpha/SKILL.md",
      "  update   json-render (as react)  unpinned..bbbbbbbbbbbb (1 commit)",
      "      files unknown (baseline: unknown)",
      "  hold     tool  aaaaaaaaaaaa..bbbbbbbbbbbb (2 commits)",
      "      M skills/tool/run.sh  [risky]",
      "  skip     vend (vendor override)",
      "  current  beta",
      "fake/two  HEAD unknown  pins: unpinned",
      "  failed   gone [fetch] git clone failed",
      "fake/three  HEAD bbbbbbbbbbbb  pins: bbbbbbbbbbbb",
      "  current  1 skill(s)",
      "Summary: 2 to update, 1 held (risky files changed), 2 current, 1 vendor override, 1 failed",
    ]);
  });

  test("--include-risky では保留が更新に数えられる", () => {
    expect(planSummary(plan, true)).toEqual({
      update: 3,
      held: 0,
      current: 2,
      vendor: 1,
      failed: 1,
    });
  });
});

describe("formatOutcomesText", () => {
  test("更新・保留・失敗の種類を分けて出す", () => {
    const outcomes: BulkUpdateSkillOutcome[] = [
      { name: "alpha", source: "fake/one", outcome: "updated", commit: HEAD },
      { name: "tool", source: "fake/one", outcome: "held", reason: "risky" },
      {
        name: "omega",
        source: "fake/three",
        outcome: "failed",
        failure: { kind: "install", message: "exit 1" },
      },
    ];
    expect(formatOutcomesText(outcomes)).toEqual([
      "Updated: alpha",
      "Held (risky files changed; review, then re-run with --include-risky): tool",
      "Failed [install] omega: exit 1",
    ]);
  });

  test("何も無ければそう言う", () => {
    expect(formatOutcomesText([])).toEqual(["Nothing to update."]);
  });
});

describe("reportExternalUpdatePlan", () => {
  test("text は計画と次の一手を出し、取得失敗を終了コードに載せる", () => {
    const { io, out } = recordingIo(false);
    expect(reportExternalUpdatePlan(plan, planOnly, io)).toBe(8);
    expect(out.at(-1)).toBe("Re-run with --apply to update.");
  });

  test("--json は stdout に 1 行だけ出す", () => {
    const { io, out } = recordingIo(true);
    reportExternalUpdatePlan(plan, planOnly, io);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({
      mode: "plan",
      summary: { update: 2, held: 1, failed: 1 },
    });
  });
});

describe("applyExternalUpdatePlan", () => {
  let sandbox: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "skill-loom-bulk-cli-"));
    for (const [name, file] of [
      ["MY_SKILLS_ACTIVE_DIR", "active"],
      ["MY_SKILLS_GLOBAL_LOCK_FILE", "cli-lock.json"],
      ["MY_SKILLS_LOCK_PINS_FILE", "skills.lock.pins.json"],
    ] as const) {
      saved.set(name, process.env[name]);
      process.env[name] = join(sandbox, file);
    }
  });

  afterEach(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("更新が無ければ確認も skills CLI も呼ばずに終える", async () => {
    const lock = { custom: { skills: {} }, external: {} };
    const session = await planExternalBulkUpdate(lock);
    try {
      const { io, out, err, confirms } = recordingIo(true);
      const args = { ...planOnly, apply: true };
      expect(applyExternalUpdatePlan(session, lock, args, io)).toBe(0);
      expect(confirms).toEqual([]);
      expect(err[0]).toBe("External update plan:");
      expect(JSON.parse(out[0] ?? "")).toMatchObject({
        mode: "apply",
        outcomes: [],
        exitCode: 0,
      });
    } finally {
      session.dispose();
    }
  });
});
