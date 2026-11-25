/**
 * `skill-loom external update --all` の引数と表示。計画と結果をテキストと `--json` の両方に整える。
 * 業務ルールは `domain/external-bulk-update.ts` が持ち、ここは並べるだけ。
 */

import {
  applyExternalBulkUpdate,
  type BulkUpdateSkillOutcome,
  externalBulkUpdateExitCode,
  holdReason,
  type ExternalBulkUpdatePlan,
  type ExternalBulkUpdateSession,
  planExitCode,
  type PlannedSkillUpdate,
  type SkillPlanEntry,
  type SourcePlan,
} from "./domain/external-bulk-update";
import type { Lock } from "./domain/inventory";

export const EXTERNAL_UPDATE_ALL_USAGE =
  "usage: skill-loom external update --all [--source OWNER/REPO] [--apply [-y]] [--include-risky] [--all-or-nothing] [--json]";

export type ExternalUpdateAllArgs = {
  apply: boolean;
  yes: boolean;
  includeRisky: boolean;
  rollbackAll: boolean;
  source: string | null;
};

const BOOLEAN_FLAGS = new Set([
  "--all",
  "--apply",
  "-y",
  "--yes",
  "--include-risky",
  "--all-or-nothing",
  "--json",
]);

function splitSource(argv: string[]): {
  source: string | null;
  rest: string[];
} {
  const index = argv.indexOf("--source");
  if (index < 0) return { source: null, rest: argv };
  return {
    source: argv[index + 1] ?? "",
    rest: argv.filter((_, at) => at !== index && at !== index + 1),
  };
}

export function parseExternalUpdateAllArgs(
  argv: string[]
): ExternalUpdateAllArgs | null {
  const { source, rest } = splitSource(argv);
  if (source === "" || rest.some((arg) => !BOOLEAN_FLAGS.has(arg))) return null;
  return {
    apply: rest.includes("--apply"),
    yes: rest.includes("-y") || rest.includes("--yes"),
    includeRisky: rest.includes("--include-risky"),
    rollbackAll: rest.includes("--all-or-nothing"),
    source,
  };
}

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "unpinned");

function rangeText(update: PlannedSkillUpdate): string {
  if (update.commits === null)
    return `${short(update.pin)}..${short(update.head)}`;
  const plural = update.commits === 1 ? "" : "s";
  return `${short(update.pin)}..${short(update.head)} (${update.commits} commit${plural})`;
}

const isHeld = (update: PlannedSkillUpdate, includeRisky: boolean) =>
  !includeRisky && holdReason(update) !== null;

function fileLines(update: PlannedSkillUpdate): string[] {
  if (update.files === null)
    return [`      files unknown (baseline: ${update.baseline})`];
  return update.files.map((file) => {
    const mark = update.risky.includes(file.path) ? "  [risky]" : "";
    return `      ${file.status} ${file.path}${mark}`;
  });
}

function updateLines(
  update: PlannedSkillUpdate,
  includeRisky: boolean
): string[] {
  const label = isHeld(update, includeRisky) ? "hold   " : "update ";
  const alias = update.aliased ? ` (as ${update.upstreamName})` : "";
  return [
    `  ${label}  ${update.name}${alias}  ${rangeText(update)}`,
    ...fileLines(update),
  ];
}

function entryLines(entry: SkillPlanEntry, includeRisky: boolean): string[] {
  if (entry.state === "update") return updateLines(entry, includeRisky);
  if (entry.state === "current") return [`  current  ${entry.name}`];
  if (entry.state === "skipped")
    return [`  skip     ${entry.name} (vendor override)`];
  return [
    `  failed   ${entry.name} [${entry.failure.kind}] ${entry.failure.message}`,
  ];
}

export function planSummary(
  plan: ExternalBulkUpdatePlan,
  includeRisky: boolean
) {
  const entries = plan.sources.flatMap((source) => source.skills);
  const count = (state: SkillPlanEntry["state"]) =>
    entries.filter((entry) => entry.state === state).length;
  const held = entries.filter(
    (entry) => entry.state === "update" && isHeld(entry, includeRisky)
  ).length;
  return {
    update: count("update") - held,
    held,
    current: count("current"),
    vendor: count("skipped"),
    failed: count("failed"),
  };
}

function sourceLines(source: SourcePlan, includeRisky: boolean): string[] {
  const head = source.head ? `HEAD ${short(source.head)}` : "HEAD unknown";
  const pins = source.pins.map(short).join(", ") || "unpinned";
  const header = `${source.source}  ${head}  pins: ${pins}`;
  if (source.skills.every((entry) => entry.state === "current"))
    return [header, `  current  ${source.skills.length} skill(s)`];
  return [
    header,
    ...source.skills.flatMap((entry) => entryLines(entry, includeRisky)),
  ];
}

export function formatPlanText(
  plan: ExternalBulkUpdatePlan,
  includeRisky: boolean
): string[] {
  const summary = planSummary(plan, includeRisky);
  return [
    "External update plan:",
    ...plan.sources.flatMap((source) => sourceLines(source, includeRisky)),
    `Summary: ${summary.update} to update, ${summary.held} held (risky or unknown changes), ${summary.current} current, ${summary.vendor} vendor override, ${summary.failed} failed`,
  ];
}

function namesLine(
  outcomes: BulkUpdateSkillOutcome[],
  kind: "updated" | "held",
  label: string
): string[] {
  const names = outcomes
    .filter((row) => row.outcome === kind)
    .map((row) => row.name);
  return names.length > 0 ? [`${label}: ${names.join(", ")}`] : [];
}

export function formatOutcomesText(
  outcomes: BulkUpdateSkillOutcome[]
): string[] {
  const lines = [
    ...namesLine(outcomes, "updated", "Updated"),
    ...namesLine(
      outcomes,
      "held",
      "Held (risky or unknown changes; review, then re-run with --include-risky)"
    ),
    ...outcomes.flatMap((row) =>
      row.outcome === "failed"
        ? [`Failed [${row.failure.kind}] ${row.name}: ${row.failure.message}`]
        : []
    ),
  ];
  return lines.length > 0 ? lines : ["Nothing to update."];
}

/** stdout と stderr、確認、skills CLI の実行。`--json` では stdout をデータ 1 行だけにする。 */
export type BulkUpdateIo = {
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  confirm: (yes: boolean) => number;
  run: (command: string[]) => void;
};

/** 計画だけを出す。何も書かない。 */
export function reportExternalUpdatePlan(
  plan: ExternalBulkUpdatePlan,
  args: ExternalUpdateAllArgs,
  io: BulkUpdateIo
): number {
  const summary = planSummary(plan, args.includeRisky);
  if (io.json) io.out(JSON.stringify({ mode: "plan", summary, plan }));
  else {
    for (const line of formatPlanText(plan, args.includeRisky)) io.out(line);
    if (summary.update > 0) io.out("Re-run with --apply to update.");
  }
  return planExitCode(plan);
}

/** 計画を見せて確認を取り、適用する。返り値は失敗の種類ごとのビットの OR。 */
export function applyExternalUpdatePlan(
  session: ExternalBulkUpdateSession,
  lock: Lock,
  args: ExternalUpdateAllArgs,
  io: BulkUpdateIo
): number {
  const summary = planSummary(session.plan, args.includeRisky);
  const show = io.json ? io.err : io.out;
  for (const line of formatPlanText(session.plan, args.includeRisky))
    show(line);
  const denied = summary.update > 0 ? io.confirm(args.yes) : 0;
  if (denied) return denied;
  const outcomes = applyExternalBulkUpdate(session, lock, {
    includeRisky: args.includeRisky,
    onFailure: args.rollbackAll ? "rollback-all" : "keep-successes",
    run: io.run,
  });
  const exitCode = externalBulkUpdateExitCode(outcomes);
  const plan = session.plan;
  if (io.json)
    io.out(
      JSON.stringify({ mode: "apply", summary, plan, outcomes, exitCode })
    );
  else for (const line of formatOutcomesText(outcomes)) io.out(line);
  return exitCode;
}
