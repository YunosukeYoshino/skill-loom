#!/usr/bin/env bun
/**
 * CLI の入口。`./skill-loom` の全サブコマンドを処理する（#75 で Python 版から一本化）。
 *
 * 出力は移行前の `bin/my-skills.py` の `cmd_*` と 1 文字も変えない。移行後に追加した
 * サブコマンドも同じ規約に倣い、CLI への出力は英語で統一する。
 *
 * preset は Web UI と同じ `domain/presets.ts` と `domain/projection.ts` を呼ぶ。
 * CLI と UI で業務ルールを二重に持たないこと（ADR 0007）。
 */

import { readSync } from "node:fs";
import {
  deckPath,
  listProjectDecks,
  loadDeck,
  saveProjectDeckSelection,
  UnknownDeckError,
} from "./domain/decks";
import { activeDir, archiveDir, lockFile } from "./domain/config";
import { collectCustomUpdatable, updateCustomFromRepo } from "./domain/custom";
import { draftRows, promoteDrafts } from "./domain/drafts";
import {
  ignoredSkills,
  loadLock,
  sortNames,
  trackedSkills,
  visibleInstalledNames,
} from "./domain/inventory";
import {
  activeExternalSkillNames,
  collectExternalUpdateStatus,
  externalUpdateCommand,
  externalSourceSummary,
} from "./domain/external";
import {
  computePresetApplyPlan,
  formatPresetApplyPreview,
  deletePreset,
  hasPreviousPreset,
  listUserPresets,
  previewNamedPreset,
  previewRestorePrevious,
  savePresetFromActive,
} from "./domain/presets";
import {
  applyDeck,
  applyProjectDeckPlan,
  applyNamedPreset,
  installCustomFromRepo,
  installProjectDeck,
  linkAgentSkillDirsMany,
  planProjectDeckSelection,
  restorePreviousPreset,
} from "./domain/projection";
import {
  externalSkillCandidates,
  normalizeGithubSource,
} from "./infrastructure/github";
import { commitRepoChanges } from "./infrastructure/git";

/** Python の `f"{value:<width}"`。 */
function padRight(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

/** Python の `f"{value:>width}"`（数値の既定は右寄せ）。 */
function padLeft(value: string, width: number): string {
  return value.length >= width
    ? value
    : " ".repeat(width - value.length) + value;
}

function difference(base: Set<string>, ...others: Set<string>[]): Set<string> {
  const out = new Set(base);
  for (const other of others) for (const name of other) out.delete(name);
  return out;
}

function cmdList(): number {
  const decks = listProjectDecks();
  if (decks.length === 0) {
    console.log("No project decks.");
    return 0;
  }
  console.log("Project decks:");
  for (const name of decks) {
    const [deck, skills] = loadDeck(name, new Set(), true);
    console.log(
      `${padRight(name, 24)} ${padLeft(String(skills.length), 3)}  ${deck.description ?? ""}`
    );
  }
  return 0;
}

function cmdStatus(): number {
  const lock = loadLock();
  const known = trackedSkills(lock);
  const unmanaged = ignoredSkills();
  const active = visibleInstalledNames(lock, activeDir());
  const archived = visibleInstalledNames(lock, archiveDir());

  console.log(`tracked:  ${known.size}`);
  console.log(`ignored:  ${unmanaged.size}`);
  console.log(`active:   ${active.size}`);
  console.log(`archive:  ${archived.size}`);
  console.log("");

  const untracked = difference(active, known, unmanaged);
  if (untracked.size > 0) {
    console.log("untracked active skills:");
    for (const name of sortNames(untracked)) console.log(`  ${name}`);
  } else {
    console.log("All active skills are tracked.");
  }
  return 0;
}

function cmdExternalList(): number {
  const sources = externalSourceSummary(loadLock());
  if (sources.length === 0) {
    console.log("No external sources.");
    return 0;
  }
  console.log("External sources:");
  for (const source of sources) {
    console.log(
      `${padRight(source.source, 32)} ${padLeft(String(source.skills.length), 3)}  ${source.skills.join(", ")}`
    );
  }
  return 0;
}

async function cmdExternalCheck(): Promise<number> {
  const lock = loadLock();
  const [statuses, errors] = await collectExternalUpdateStatus(lock);
  console.log("External update check:");
  for (const source of externalSourceSummary(lock)) {
    const status = statuses[source.source];
    if (!status?.checked) {
      console.log(
        `${source.source}  check failed: ${status?.error ?? "unknown error"}`
      );
      continue;
    }
    const updatable = status.updatable ?? [];
    console.log(
      updatable.length > 0
        ? `${source.source}  updates: ${updatable.join(", ")}`
        : `${source.source}  up to date`
    );
  }
  return errors.length > 0 ? 1 : 0;
}

function cmdExternalPreview(source: string): number {
  try {
    const ownerRepo = normalizeGithubSource(source);
    const candidates = externalSkillCandidates(ownerRepo);
    console.log(`External source: ${ownerRepo}`);
    if (candidates.length === 0) {
      console.log("No Skill candidates.");
      return 0;
    }
    for (const candidate of candidates) {
      const path = candidate.path ? `  ${candidate.path}` : "";
      console.log(`${candidate.name}${path}`);
    }
    return 0;
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
}

function runCommand(command: string[]): void {
  const result = Bun.spawnSync(command, {
    stdout: "inherit",
    stderr: "inherit",
    timeout: 180_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed with exit status ${result.exitCode}`);
  }
}

/** 確認プロンプトの共通部分。`-y` なら聞かず、断られれば Aborted。 */
function confirmProceed(yes: boolean): boolean {
  if (yes || confirmed("Continue? [y/N] ")) return true;
  console.log("Aborted.");
  return false;
}

function confirmedAction(
  label: string,
  names: string[],
  yes: boolean
): boolean {
  console.log(`${label}: ${names.join(", ")}`);
  return confirmProceed(yes);
}

/** `-y/--yes` を外して、残りと yes フラグを返す。各 update 系サブコマンド共通。 */
function parseYesArgs(argv: string[]): { yes: boolean; names: string[] } {
  const yes = argv.includes("-y") || argv.includes("--yes");
  const names = argv.filter((arg) => arg !== "-y" && arg !== "--yes");
  return { yes, names };
}

function cmdExternalUpdate(argv: string[]): number {
  const { yes, names } = parseYesArgs(argv);
  if (names.length === 0) {
    console.error(
      "skill-loom external update: the following arguments are required: names"
    );
    return 2;
  }
  const lock = loadLock();
  const active = activeExternalSkillNames(lock);
  const inactive = names.filter((name) => !active.has(name));
  if (inactive.length > 0) {
    console.error(`cannot update because not active: ${inactive.join(", ")}`);
    return 2;
  }
  if (!confirmedAction("Update External Skills", names, yes)) return 1;
  try {
    for (const name of names) runCommand(externalUpdateCommand(name));
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
  console.log(`Updated: ${names.join(", ")}`);
  return 0;
}

async function cmdExternal(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") return cmdExternalList();
  if (subcommand === "check") return await cmdExternalCheck();
  if (subcommand === "preview") {
    if (!rest[0]) {
      console.error(
        "skill-loom external preview: the following arguments are required: source"
      );
      return 2;
    }
    return cmdExternalPreview(rest[0]);
  }
  if (subcommand === "update") return cmdExternalUpdate(rest);
  console.error(`skill-loom external: invalid choice: ${subcommand ?? ""}`);
  return 2;
}

function cmdCustom(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "check") {
    const rows = collectCustomUpdatable(loadLock());
    console.log("Custom update check:");
    if (rows.length === 0) console.log("All custom skills are up to date.");
    for (const row of rows) console.log(`${row.name}  ${row.state}`);
    return 0;
  }
  if (subcommand === "update") {
    const { yes, names } = parseYesArgs(rest);
    if (names.length === 0) {
      console.error(
        "skill-loom custom update: the following arguments are required: names"
      );
      return 2;
    }
    const lock = loadLock();
    const custom = lock.custom?.skills ?? {};
    const unknown = names.filter((name) => !(name in custom));
    if (unknown.length > 0) {
      console.error(`not custom skills: ${unknown.join(", ")}`);
      return 2;
    }
    if (!confirmedAction("Update Custom Skills", names, yes)) return 1;
    try {
      const updated = updateCustomFromRepo(new Set(names), lock);
      console.log(`Updated: ${updated.join(", ")}`);
      return 0;
    } catch (error) {
      console.error(errorText(error));
      return 2;
    }
  }
  console.error(`skill-loom custom: invalid choice: ${subcommand ?? ""}`);
  return 2;
}

function cmdDraft(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") {
    const rows = draftRows(loadLock());
    if (rows.length === 0) {
      console.log("No draft skills.");
      return 0;
    }
    console.log("Draft skills:");
    for (const row of rows)
      console.log(
        `${padRight(row.name, 24)} ${padRight(row.category, 16)} ${row.description}`
      );
    return 0;
  }
  if (subcommand === "promote" || subcommand === "install") {
    const { yes, names } = parseYesArgs(rest);
    const force = rest.includes("--force");
    const skillNames = names.filter((arg) => arg !== "--force");
    if (skillNames.length === 0) {
      console.error(
        `skill-loom draft ${subcommand}: the following arguments are required: names`
      );
      return 2;
    }
    const label =
      subcommand === "install"
        ? "Install Draft Skills"
        : "Promote Draft Skills";
    if (!confirmedAction(label, skillNames, yes)) return 1;
    try {
      const [promoted, newLock, commitPaths] = promoteDrafts(
        new Set(skillNames),
        force
      );
      const paths = [lockFile(), ...commitPaths];
      const commitNote = commitRepoChanges(
        `feat: add ${promoted.join(", ")}`,
        paths
      );
      if (subcommand === "install")
        installCustomFromRepo(new Set(promoted), newLock);
      console.log(`Promoted: ${promoted.join(", ")}${commitNote}`);
      return 0;
    } catch (error) {
      console.error(errorText(error));
      return 2;
    }
  }
  console.error(`skill-loom draft: invalid choice: ${subcommand ?? ""}`);
  return 2;
}

function cmdDeck(argv: string[]): number {
  const [subcommand, deckName, ...rest] = argv;
  if (!deckName) {
    console.error(
      `skill-loom deck ${subcommand ?? ""}: the following arguments are required: name`
    );
    return 2;
  }
  if (subcommand === "show") {
    try {
      const [deck, skills] = loadDeck(deckName, new Set(), true);
      console.log(`Project deck: ${deckName}`);
      if (deck.description) console.log(deck.description);
      for (const name of skills) console.log(`  ${name}`);
      return 0;
    } catch (error) {
      console.error(errorText(error));
      return 2;
    }
  }
  if (subcommand === "save") {
    const { yes, names } = parseYesArgs(rest);
    if (names.length === 0) {
      console.error(
        "skill-loom deck save: the following arguments are required: names"
      );
      return 2;
    }
    if (!confirmedAction(`Save Project Deck ${deckName}`, names, yes)) return 1;
    try {
      const count = saveProjectDeckSelection(deckName, new Set(names));
      const commitNote = commitRepoChanges(
        `chore: save project deck ${deckName}`,
        [deckPath(deckName, true)]
      );
      console.log(
        `Saved deck: ${deckName} (${count} direct skills)${commitNote}`
      );
      return 0;
    } catch (error) {
      console.error(errorText(error));
      return 2;
    }
  }
  if (subcommand === "apply" || subcommand === "merge") {
    const { yes } = parseYesArgs(rest);
    try {
      const [, skills] = loadDeck(deckName, new Set(), true);
      const lock = loadLock();
      const selected = new Set(skills);
      const plan = planProjectDeckSelection(
        deckName,
        selected,
        subcommand,
        lock
      );
      console.log(
        `${subcommand === "merge" ? "Merge" : "Apply"} Project Deck ${deckName}`
      );
      const printNames = (label: string, names: Set<string>): void => {
        console.log(`${label}: ${sortNames(names).join(", ") || "(none)"}`);
      };
      printNames("target", plan.target);
      printNames("archive", plan.extra);
      printNames("restore", plan.restore);
      printNames("install", plan.install);
      printNames("unresolved", plan.unresolved);
      if (!confirmProceed(yes)) return 1;
      const result = applyProjectDeckPlan(plan, lock);
      if (result.unresolved.size > 0) {
        console.error(`Unresolved: ${sortNames(result.unresolved).join(", ")}`);
        return 2;
      }
      console.log(`Applied deck: ${deckName}`);
      return 0;
    } catch (error) {
      console.error(errorText(error));
      return 2;
    }
  }
  console.error(`skill-loom deck: invalid choice: ${subcommand ?? ""}`);
  return 2;
}

/** `print_plan` の移植。`--apply` で使うため計算した各集合も返す。 */
function printPlan(
  target: Set<string>,
  lock: ReturnType<typeof loadLock>
): {
  unresolved: boolean;
  extra: Set<string>;
  restore: Set<string>;
  install: Set<string>;
  known: Set<string>;
} {
  const active = visibleInstalledNames(lock, activeDir());
  const archived = visibleInstalledNames(lock, archiveDir());
  const managed = trackedSkills(lock);
  const unmanaged = ignoredSkills();
  const known = new Set([...managed, ...unmanaged]);

  const unresolved = difference(target, known, active, archived);
  const extra = difference(active, target);
  const restore = difference(
    new Set([...target].filter((n) => archived.has(n))),
    active
  );
  const install = difference(target, active, archived, unmanaged);
  const unmanagedMissing = difference(
    new Set([...target].filter((n) => unmanaged.has(n))),
    active,
    archived
  );

  console.log(`active:   ${active.size}`);
  console.log(`target:   ${target.size}`);
  console.log(`archive:  ${archived.size}`);
  console.log("");

  if (unresolved.size > 0) {
    console.log("unresolved target skills:");
    for (const name of sortNames(unresolved)) console.log(`  ${name}`);
    console.log("");
  }

  const section = (label: string, names: Set<string>): void => {
    console.log(`${label} ${names.size}`);
    for (const name of sortNames(names)) console.log(`  ${name}`);
  };

  section("move to archive:", extra);
  console.log("");
  section("restore from archive:", restore);
  console.log("");
  section("install missing:", install);
  console.log("");
  section("unmanaged missing:", unmanagedMissing);

  return { unresolved: unresolved.size > 0, extra, restore, install, known };
}

/**
 * `all`。tracked skill を全件 active へ揃える。
 *
 * `--apply` が無ければ dry-run。`--apply` があれば `apply_deck(extra, restore, install & known)`
 * と同じ projection を走らせる。`install & known` は「管理対象に限る」の念押し（移行前どおり）。
 */
function cmdAll(argv: string[]): number {
  const lock = loadLock();
  const plan = printPlan(trackedSkills(lock), lock);
  if (plan.unresolved) return 2;
  const apply = argv.includes("--apply");
  if (!apply) {
    console.log("");
    console.log("dry-run only; add --apply to restore all tracked skills");
    return 0;
  }
  const installKnown = new Set(
    [...plan.install].filter((name) => plan.known.has(name))
  );
  applyDeck(plan.extra, plan.restore, installKnown, lock);
  return 0;
}

/**
 * `link-agents`。指定 skill の agent symlink を張る。
 *
 * install 系が内部で呼ぶ `link_agent_skill_dirs_many` を単体で出す、保守用の抜け道。
 */
function cmdLinkAgents(names: string[]): number {
  linkAgentSkillDirsMany(names);
  return 0;
}

/**
 * `install-deck`。deck の skill を active へ揃える。
 *
 * 取得元の分からない skill が 1 つでもあれば、何も動かさずに 2 で抜ける。
 * 半端に入れると、どこまで入ったのかを利用者が追えなくなる。
 */
function cmdInstallDeck(name: string): number {
  const lock = loadLock();
  let result: ReturnType<typeof installProjectDeck>;
  try {
    result = installProjectDeck(name, lock);
  } catch (error) {
    // 移行前は `SystemExit(f"Unknown project deck: ...")`。メッセージだけ出して 1 で抜ける。
    if (!(error instanceof UnknownDeckError)) throw error;
    console.error(errorText(error));
    return 1;
  }
  if (result.unresolved.size > 0) {
    console.log("unresolved deck skills:");
    for (const skill of sortNames(result.unresolved)) console.log(`  ${skill}`);
    return 2;
  }
  console.log(`deck:           ${name}`);
  console.log(`already active: ${result.alreadyActive.size}`);
  console.log(`restored:       ${result.restore.size}`);
  console.log(`installed:      ${result.install.size}`);
  return 0;
}

// ---- preset ----

/** 例外を `str(exc)` 相当の 1 行にする。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Python の `input()` 相当。プロンプトを改行なしで出し、1 行読む。
 *
 * 1 バイトずつ読むのは、返事の後ろに続く入力を食べてしまわないため。
 * EOF は空文字を返し、呼び出し側では「y ではない」= 中止になる。
 */
function askLine(question: string): string {
  process.stdout.write(question);
  const byte = Buffer.alloc(1);
  let line = "";
  while (true) {
    let read = 0;
    try {
      read = readSync(0, byte, 0, 1, null);
    } catch {
      break;
    }
    if (read === 0) break;
    const char = byte.toString("utf8");
    if (char === "\n") break;
    line += char;
  }
  return line;
}

function confirmed(question: string): boolean {
  const answer = askLine(question).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function cmdPresetList(): number {
  const presets = listUserPresets();
  if (presets.length === 0) {
    console.log("No presets.");
    return 0;
  }
  for (const preset of presets) {
    const suffix = preset.description ? `  ${preset.description}` : "";
    console.log(
      `${padRight(preset.name, 24)} ${padLeft(String(preset.skillCount), 3)}${suffix}`
    );
  }
  return 0;
}

function cmdPresetSave(args: PresetArgs): number {
  let saved: ReturnType<typeof savePresetFromActive>;
  try {
    saved = savePresetFromActive(
      args.name,
      loadLock(),
      args.description,
      args.overwrite
    );
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
  console.log(`Saved preset ${saved.name} (${saved.skills.length} skills)`);
  return 0;
}

function cmdPresetApply(args: PresetArgs): number {
  const lock = loadLock();
  let preview: ReturnType<typeof previewNamedPreset>;
  try {
    preview = previewNamedPreset(args.name, lock);
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }

  console.log(
    formatPresetApplyPreview(
      computePresetApplyPlan(new Set(preview.skills), lock)
    )
  );
  if (preview.blocked) return 2;
  if (!args.yes && !confirmed("Apply this preset? [y/N] ")) {
    console.log("Aborted.");
    return 1;
  }

  try {
    applyNamedPreset(args.name, lock, true);
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
  console.log(`Applied preset: ${args.name}`);
  return 0;
}

function cmdPresetRestore(args: PresetArgs): number {
  const lock = loadLock();
  if (!hasPreviousPreset()) {
    console.error("No previous state saved");
    return 2;
  }

  let preview: ReturnType<typeof previewRestorePrevious>;
  try {
    preview = previewRestorePrevious(lock);
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }

  // preview と同じ条件（archive は触らない）で計画し直してから見せる。
  const plan = computePresetApplyPlan(new Set(preview.skills), lock, false);
  console.log(formatPresetApplyPreview(plan));
  if (plan.unresolved.size > 0)
    console.error(`skip unresolved: ${sortNames(plan.unresolved).join(", ")}`);
  if (!args.yes && !confirmed("Restore previous active set? [y/N] ")) {
    console.log("Aborted.");
    return 1;
  }

  try {
    restorePreviousPreset(lock);
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
  console.log("Restored previous active set");
  return 0;
}

function cmdPresetDelete(args: PresetArgs): number {
  try {
    deletePreset(args.name);
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
  console.log(`Deleted preset: ${args.name}`);
  return 0;
}

type PresetArgs = {
  name: string;
  description: string;
  overwrite: boolean;
  yes: boolean;
};

/** argparse の `preset` サブパーサ相当。位置引数は name 1 つだけ。 */
function parsePresetArgs(argv: string[]): PresetArgs {
  const args: PresetArgs = {
    name: "",
    description: "",
    overwrite: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--description") args.description = argv[++i] ?? "";
    else if (arg.startsWith("--description="))
      args.description = arg.slice("--description=".length);
    else if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "-y" || arg === "--yes") args.yes = true;
    else if (!args.name) args.name = arg;
  }
  return args;
}

function cmdPreset(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  const args = parsePresetArgs(rest);

  switch (subcommand) {
    case "list":
      return cmdPresetList();
    case "save":
    case "apply":
    case "delete":
      if (!args.name) {
        console.error(
          `skill-loom preset ${subcommand}: the following arguments are required: name`
        );
        return 2;
      }
      if (subcommand === "save") return cmdPresetSave(args);
      if (subcommand === "apply") return cmdPresetApply(args);
      return cmdPresetDelete(args);
    case "restore":
      return cmdPresetRestore(args);
    default:
      console.error(`skill-loom preset: invalid choice: ${subcommand ?? ""}`);
      return 2;
  }
}

const [command, ...rest] = Bun.argv.slice(2);

/** `argparse` が出す usage 行。no-args / unknown command で共通して使う。 */
const USAGE =
  "usage: skill-loom [-h] {list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck} ...";

/**
 * `argparse` の `--help`。1 文字まで移行前と合わせるので、画面の端で折れる幅も含めて
 * 固定文字列にしている（`link-agents` の説明が 80 桁で折れるのも再現）。
 */
const HELP = `usage: skill-loom [-h] {list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck} ...

positional arguments:
  {list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck}
    list                List project decks
    status              Show active/archive state
    all                 Preview or restore all tracked skills
    install-deck        Install project deck skills into active global skills
    link-agents         Symlink ~/.claude/skills and ~/.gemini/config/skills
                        to ~/.agents/skills
    ui                  Start a local HTML checklist for active skills
    preset              Manage local global skill presets
    external            Manage External Skills
    custom              Check and update Custom Skills
    draft               List, promote, or install Draft Skills
    deck                Show, save, merge, or apply Project Decks

options:
  -h, --help            show this help message and exit
`;

// argparse は `-h/--help` で stdout へ出して 0、サブコマンド無しで stderr へ 2。
if (command === "-h" || command === "--help") {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === undefined) {
  console.error(USAGE);
  console.error(
    "skill-loom: error: the following arguments are required: command"
  );
  process.exit(2);
}

switch (command) {
  case "list":
    process.exit(cmdList());
    break;
  case "status":
    process.exit(cmdStatus());
    break;
  case "all":
    process.exit(cmdAll(rest));
    break;
  case "install-deck":
    if (rest.length !== 1 || !rest[0]) {
      // argparse が出していた 2 行をそのまま再現する。
      console.error("usage: skill-loom install-deck [-h] name");
      console.error(
        "skill-loom install-deck: error: the following arguments are required: name"
      );
      process.exit(2);
    }
    process.exit(cmdInstallDeck(rest[0]));
    break;
  case "link-agents":
    if (rest.length === 0) {
      // argparse (nargs="+") が出していた 2 行をそのまま再現する。
      console.error("usage: skill-loom link-agents [-h] names [names ...]");
      console.error(
        "skill-loom link-agents: error: the following arguments are required: names"
      );
      process.exit(2);
    }
    process.exit(cmdLinkAgents(rest));
    break;
  case "preset":
    process.exit(cmdPreset(rest));
    break;
  case "external":
    process.exit(await cmdExternal(rest));
    break;
  case "custom":
    process.exit(cmdCustom(rest));
    break;
  case "draft":
    process.exit(cmdDraft(rest));
    break;
  case "deck":
    process.exit(cmdDeck(rest));
    break;
  default:
    // argparse の invalid choice。stdout ではなく stderr へ。
    console.error(USAGE);
    console.error(
      `skill-loom: error: argument command: invalid choice: '${command}' (choose from list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck)`
    );
    process.exit(2);
}
