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
import {
  activeDir,
  archiveDir,
  lockFile,
  PRESET_LAST_NAME,
} from "./domain/config";
import { collectCustomUpdatable, updateCustomFromRepo } from "./domain/custom";
import { draftRows, promoteDrafts } from "./domain/drafts";
import {
  difference,
  ignoredSkills,
  loadLock,
  type Selection,
  sortNames,
  trackedSkills,
  visibleInstalledNames,
} from "./domain/inventory";
import {
  activeExternalSkillNames,
  collectExternalUpdateStatus,
  externalSourceSummary,
  runExternalSkillUpdate,
} from "./domain/external";
import {
  backupActiveToLast,
  computePresetApplyPlan,
  computeSnapshotPlan,
  formatPresetApplyPreview,
  deletePreset,
  hasPreviousPreset,
  listUserPresets,
  loadPreset,
  previewNamedPreset,
  savePresetFromActive,
} from "./domain/presets";
import {
  applyDeck,
  applyProjectDeckPlan,
  applyNamedPreset,
  applyRestoreAllPlan,
  installCustomFromRepo,
  installProjectDeck,
  linkAgentSkillDirsMany,
  planProjectDeckSelection,
  planRestoreAll,
  restorePreviousPreset,
} from "./domain/projection";
import { computeTristateApplyDelta, TRISTATE_VALUES } from "./domain/tristate";
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

// ---- --json ----

/**
 * `--json` で stdout を機械可読にする opt-in。既定のテキスト出力は一切変えない。
 * list 系は 1 件 1 行の JSON Lines、それ以外は 1 コマンド 1 オブジェクトを出す。
 */
const jsonMode = Bun.argv.slice(2).includes("--json");

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** `--json` 時のエラーも stderr の 1 行 JSON。`hint` は次に打つべきコマンドを名指しする。 */
function emitJsonError(
  error: string,
  hint: string,
  extra?: Record<string, unknown>
): void {
  console.error(JSON.stringify({ error, ...extra, hint }));
}

/**
 * エラー終了の共通部。`--json` では `{error, hint}` を stderr に出し、
 * text では `textLines`（省略時は `hint` そのもの）を出して 2 を返す。
 */
function cliError(error: string, hint: string, ...textLines: string[]): number {
  if (jsonMode) {
    emitJsonError(error, hint);
  } else {
    for (const line of textLines.length > 0 ? textLines : [hint])
      console.error(line);
  }
  return 2;
}

/** catch 節用。text では例外本文、JSON では本文を `error` にして `hint` を次の一手にする。 */
function failFromError(error: unknown, hint: string): number {
  const message = errorText(error);
  return cliError(message, hint, message);
}

const HINT_UNRESOLVED =
  "register the skill first (skills-add or draft promote), or check spelling via status --json";
const HINT_DECK_PRESET =
  "list available decks via list --json / presets via preset list --json";

/** git commit note の連結用プレフィクス " / " を剥がす。空なら null。 */
function commitNoteText(note: string): string | null {
  return note ? note.replace(/^ \/ /, "") : null;
}

function cmdList(): number {
  const decks = listProjectDecks();
  if (decks.length === 0) {
    if (!jsonMode) console.log("No project decks.");
    return 0;
  }
  if (jsonMode) {
    for (const name of decks) {
      const [deck, skills] = loadDeck(name, new Set(), true);
      emitJson(
        deck.description
          ? { name, skills: skills.length, description: deck.description }
          : { name, skills: skills.length }
      );
    }
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
  const untracked = difference(active, known, unmanaged);

  if (jsonMode) {
    emitJson({
      tracked: known.size,
      ignored: unmanaged.size,
      active: active.size,
      archive: archived.size,
      untracked: sortNames(untracked),
    });
    return 0;
  }

  console.log(`tracked:  ${known.size}`);
  console.log(`ignored:  ${unmanaged.size}`);
  console.log(`active:   ${active.size}`);
  console.log(`archive:  ${archived.size}`);
  console.log("");

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
    if (!jsonMode) console.log("No external sources.");
    return 0;
  }
  if (jsonMode) {
    for (const source of sources)
      emitJson({ source: source.source, skills: source.skills });
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
  if (jsonMode) {
    for (const source of externalSourceSummary(lock)) {
      const status = statuses[source.source];
      emitJson(
        status?.checked
          ? {
              source: source.source,
              checked: true,
              updatable: status.updatable ?? [],
            }
          : {
              source: source.source,
              checked: false,
              updatable: [],
              error: status?.error ?? "unknown error",
            }
      );
    }
    return errors.length > 0 ? 1 : 0;
  }
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
    if (jsonMode) {
      emitJson({
        source: ownerRepo,
        candidates: candidates.map((candidate) =>
          candidate.path
            ? { name: candidate.name, path: candidate.path }
            : { name: candidate.name }
        ),
      });
      return 0;
    }
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
    if (jsonMode) {
      emitJsonError(
        errorText(error),
        "check the source as owner/repo or a GitHub URL"
      );
      return 2;
    }
    console.error(errorText(error));
    return 2;
  }
}

function runCommand(command: string[]): void {
  const result = Bun.spawnSync(command, {
    // `--json` では子プロセスの stdout がデータ行を汚さないよう stderr へ流す。
    stdout: jsonMode ? "pipe" : "inherit",
    stderr: "inherit",
    timeout: 180_000,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed with exit status ${result.exitCode}`);
  }
}

/**
 * 確認プロンプトの共通部分。返り値はそのまま exit code（0 = 続行）。
 *
 * `--json` では人間向けの出力（プロンプト・見出し・Aborted）をすべて stderr へ寄せ、
 * stdout をデータ行だけにする。
 */
function confirmProceed(yes: boolean, question = "Continue? [y/N] "): number {
  if (yes) return 0;
  // `--json` で stdin が TTY でなければ対話できない。書き込み前に 2 で抜ける。
  if (jsonMode && !process.stdin.isTTY) {
    emitJsonError("confirmation required", "re-run with -y");
    return 2;
  }
  if (confirmed(question)) return 0;
  if (jsonMode) console.error(JSON.stringify({ aborted: true }));
  else console.log("Aborted.");
  return 1;
}

function confirmedAction(label: string, names: string[], yes: boolean): number {
  if (jsonMode) console.error(`${label}: ${names.join(", ")}`);
  else console.log(`${label}: ${names.join(", ")}`);
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
  if (names.length === 0)
    return cliError(
      "missing required argument",
      "skill-loom external update: the following arguments are required: names"
    );
  const lock = loadLock();
  const active = activeExternalSkillNames(lock);
  const inactive = names.filter((name) => !active.has(name));
  if (inactive.length > 0) {
    if (jsonMode) {
      emitJsonError(
        "cannot update because not active",
        `set them active first: skill-loom skill active ${inactive.join(" ")}`,
        { names: inactive }
      );
      return 2;
    }
    console.error(`cannot update because not active: ${inactive.join(", ")}`);
    return 2;
  }
  const denied = confirmedAction("Update External Skills", names, yes);
  if (denied) return denied;
  try {
    for (const name of names) runExternalSkillUpdate(name, lock, runCommand);
  } catch (error) {
    return failFromError(
      error,
      "check update status via external check --json"
    );
  }
  if (jsonMode) emitJson({ updated: names });
  else console.log(`Updated: ${names.join(", ")}`);
  return 0;
}

async function cmdExternal(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") return cmdExternalList();
  if (subcommand === "check") return await cmdExternalCheck();
  if (subcommand === "preview") {
    if (!rest[0])
      return cliError(
        "missing required argument",
        "skill-loom external preview: the following arguments are required: source"
      );
    return cmdExternalPreview(rest[0]);
  }
  if (subcommand === "update") return cmdExternalUpdate(rest);
  return cliError(
    "invalid choice",
    "usage: skill-loom external {list,check,preview,update} ...",
    `skill-loom external: invalid choice: ${subcommand ?? ""}`
  );
}

function cmdCustom(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "check") {
    const rows = collectCustomUpdatable(loadLock());
    if (jsonMode) {
      emitJson({
        updatable: rows.map((row) => ({ name: row.name, state: row.state })),
      });
      return 0;
    }
    console.log("Custom update check:");
    if (rows.length === 0) console.log("All custom skills are up to date.");
    for (const row of rows) console.log(`${row.name}  ${row.state}`);
    return 0;
  }
  if (subcommand === "update") {
    const { yes, names } = parseYesArgs(rest);
    if (names.length === 0)
      return cliError(
        "missing required argument",
        "skill-loom custom update: the following arguments are required: names"
      );
    const lock = loadLock();
    const custom = lock.custom?.skills ?? {};
    const unknown = names.filter((name) => !(name in custom));
    if (unknown.length > 0) {
      if (jsonMode) {
        emitJsonError(
          "not custom skills",
          "check custom skill names via custom check --json",
          { names: unknown }
        );
        return 2;
      }
      console.error(`not custom skills: ${unknown.join(", ")}`);
      return 2;
    }
    const denied = confirmedAction("Update Custom Skills", names, yes);
    if (denied) return denied;
    try {
      const updated = updateCustomFromRepo(new Set(names), lock);
      if (jsonMode) emitJson({ updated });
      else console.log(`Updated: ${updated.join(", ")}`);
      return 0;
    } catch (error) {
      return failFromError(
        error,
        "check the custom skill state via custom check --json"
      );
    }
  }
  return cliError(
    "invalid choice",
    "usage: skill-loom custom {check,update} ...",
    `skill-loom custom: invalid choice: ${subcommand ?? ""}`
  );
}

function cmdDraft(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") {
    const rows = draftRows(loadLock());
    if (rows.length === 0) {
      if (!jsonMode) console.log("No draft skills.");
      return 0;
    }
    if (jsonMode) {
      for (const row of rows)
        emitJson({
          name: row.name,
          category: row.category,
          description: row.description,
        });
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
    if (skillNames.length === 0)
      return cliError(
        "missing required argument",
        `skill-loom draft ${subcommand}: the following arguments are required: names`
      );
    const label =
      subcommand === "install"
        ? "Install Draft Skills"
        : "Promote Draft Skills";
    const denied = confirmedAction(label, skillNames, yes);
    if (denied) return denied;
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
      if (jsonMode) {
        emitJson({ promoted, committed: commitNoteText(commitNote) });
        return 0;
      }
      console.log(`Promoted: ${promoted.join(", ")}${commitNote}`);
      return 0;
    } catch (error) {
      return failFromError(error, "check draft names via draft list --json");
    }
  }
  return cliError(
    "invalid choice",
    "usage: skill-loom draft {list,promote,install} ...",
    `skill-loom draft: invalid choice: ${subcommand ?? ""}`
  );
}

function cmdDeck(argv: string[]): number {
  const [subcommand, deckName, ...rest] = argv;
  if (!deckName)
    return cliError(
      "missing required argument",
      `skill-loom deck ${subcommand ?? ""}: the following arguments are required: name`
    );
  if (subcommand === "show") {
    try {
      const [deck, skills] = loadDeck(deckName, new Set(), true);
      if (jsonMode) {
        emitJson(
          deck.description
            ? { name: deckName, description: deck.description, skills }
            : { name: deckName, skills }
        );
        return 0;
      }
      console.log(`Project deck: ${deckName}`);
      if (deck.description) console.log(deck.description);
      for (const name of skills) console.log(`  ${name}`);
      return 0;
    } catch (error) {
      return failFromError(error, HINT_DECK_PRESET);
    }
  }
  if (subcommand === "save") {
    const { yes, names } = parseYesArgs(rest);
    if (names.length === 0)
      return cliError(
        "missing required argument",
        "skill-loom deck save: the following arguments are required: names"
      );
    const denied = confirmedAction(`Save Project Deck ${deckName}`, names, yes);
    if (denied) return denied;
    try {
      const count = saveProjectDeckSelection(deckName, new Set(names));
      const commitNote = commitRepoChanges(
        `chore: save project deck ${deckName}`,
        [deckPath(deckName, true)]
      );
      if (jsonMode) {
        emitJson({
          deck: deckName,
          count,
          committed: commitNoteText(commitNote),
        });
        return 0;
      }
      console.log(
        `Saved deck: ${deckName} (${count} direct skills)${commitNote}`
      );
      return 0;
    } catch (error) {
      return failFromError(error, HINT_DECK_PRESET);
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
      const planJson = (applied: boolean) => ({
        deck: deckName,
        target: sortNames(plan.target),
        archive: sortNames(plan.extra),
        restore: sortNames(plan.restore),
        install: sortNames(plan.install),
        unresolved: sortNames(plan.unresolved),
        applied,
      });
      if (jsonMode) emitJson(planJson(false));
      else {
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
      }
      const denied = confirmProceed(yes);
      if (denied) return denied;
      const result = applyProjectDeckPlan(plan, lock);
      if (result.unresolved.size > 0) {
        if (jsonMode) {
          emitJsonError("unresolved skills", HINT_UNRESOLVED, {
            names: sortNames(result.unresolved),
          });
          return 2;
        }
        console.error(`Unresolved: ${sortNames(result.unresolved).join(", ")}`);
        return 2;
      }
      if (jsonMode) emitJson(planJson(true));
      else console.log(`Applied deck: ${deckName}`);
      return 0;
    } catch (error) {
      return failFromError(error, HINT_DECK_PRESET);
    }
  }
  return cliError(
    "invalid choice",
    "usage: skill-loom deck {show,save,apply,merge} name ...",
    `skill-loom deck: invalid choice: ${subcommand ?? ""}`
  );
}

/**
 * `all`。tracked skill を全件 active へ揃える。
 *
 * `--apply` が無ければ dry-run。`--apply` があれば直前の active を `_last` へ退避してから
 * projection を走らせる。計画も適用も Web UI の /api/all と同じ関数を通る。
 */
function cmdAll(argv: string[]): number {
  const lock = loadLock();
  const plan = planRestoreAll(lock);
  const active = visibleInstalledNames(lock, activeDir());
  const archived = visibleInstalledNames(lock, archiveDir());

  if (jsonMode) {
    const planJson = (applied: boolean) => ({
      counts: {
        active: active.size,
        target: trackedSkills(lock).size,
        archive: archived.size,
      },
      extra: sortNames(plan.extra),
      restore: sortNames(plan.restore),
      install: sortNames(plan.install),
      applied,
    });
    emitJson(planJson(false));
    if (!argv.includes("--apply")) return 0;
    applyRestoreAllPlan(plan, lock);
    emitJson(planJson(true));
    return 0;
  }

  console.log(`active:   ${active.size}`);
  console.log(`target:   ${trackedSkills(lock).size}`);
  console.log(`archive:  ${archived.size}`);
  console.log("");

  const section = (label: string, names: Set<string>): void => {
    console.log(`${label} ${names.size}`);
    for (const name of sortNames(names)) console.log(`  ${name}`);
  };

  section("move to archive:", plan.extra);
  console.log("");
  section("restore from archive:", plan.restore);
  console.log("");
  section("install missing:", plan.install);

  if (!argv.includes("--apply")) {
    console.log("");
    console.log("dry-run only; add --apply to restore all tracked skills");
    return 0;
  }
  applyRestoreAllPlan(plan, lock);
  return 0;
}

/**
 * `link-agents`。指定 skill の agent symlink を張る。
 *
 * install 系が内部で呼ぶ `link_agent_skill_dirs_many` を単体で出す、保守用の抜け道。
 */
function cmdLinkAgents(names: string[]): number {
  linkAgentSkillDirsMany(names);
  if (jsonMode) emitJson({ linked: names });
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
    if (jsonMode) emitJsonError(errorText(error), HINT_DECK_PRESET);
    else console.error(errorText(error));
    return 1;
  }
  if (result.unresolved.size > 0) {
    if (jsonMode) {
      emitJsonError("unresolved skills", HINT_UNRESOLVED, {
        names: sortNames(result.unresolved),
      });
      return 2;
    }
    console.log("unresolved deck skills:");
    for (const skill of sortNames(result.unresolved)) console.log(`  ${skill}`);
    return 2;
  }
  if (jsonMode) {
    emitJson({
      deck: name,
      alreadyActive: result.alreadyActive.size,
      restored: result.restore.size,
      installed: result.install.size,
    });
    return 0;
  }
  console.log(`deck:           ${name}`);
  console.log(`already active: ${result.alreadyActive.size}`);
  console.log(`restored:       ${result.restore.size}`);
  console.log(`installed:      ${result.install.size}`);
  return 0;
}

/**
 * `skill`。名前を挙げた skill を active / archive / off のどれかへ移す。
 *
 * UI の Apply と同じ computeTristateApplyDelta → applyDeck の経路を通す。
 * unresolved が 1 つでもあれば書き込む前に 2 で抜ける（install-deck と同じ方針）。
 */
function cmdSkill(argv: string[]): number {
  const usage =
    "usage: skill-loom skill [-h] [-y] {active,archive,off} names [names ...]";
  const { yes, names: args } = parseYesArgs(argv);
  const [desired, ...names] = args;
  if (desired === undefined || !TRISTATE_VALUES.has(desired))
    return cliError(
      desired === undefined ? "missing required argument" : "invalid choice",
      usage,
      usage,
      desired === undefined
        ? "skill-loom skill: error: the following arguments are required: state, names"
        : `skill-loom skill: error: argument state: invalid choice: '${desired}' (choose from active,archive,off)`
    );
  if (names.length === 0)
    return cliError(
      "missing required argument",
      usage,
      usage,
      "skill-loom skill: error: the following arguments are required: names"
    );

  const lock = loadLock();
  const state = desired as Selection;
  const states = Object.fromEntries(names.map((name) => [name, state]));
  const delta = computeTristateApplyDelta(states, lock);

  // 名前を挙げて動かすコマンドでは「変化なし」を黙って成功にしない。
  // UI の delta が no-op として許す 2 種（off への未知名、install 経路の無い
  // ignored な active/archive 指定）もここで unresolved に畳み込む。
  const active = visibleInstalledNames(lock, activeDir());
  const archived = visibleInstalledNames(lock, archiveDir());
  const managed = trackedSkills(lock);
  const known = new Set([
    ...managed,
    ...ignoredSkills(),
    ...active,
    ...archived,
  ]);
  const blocked = names.filter((name) =>
    state === "off"
      ? !known.has(name)
      : !managed.has(name) && !active.has(name) && !archived.has(name)
  );
  const unresolved = sortNames(new Set([...blocked, ...delta.unresolved]));
  if (unresolved.length > 0) {
    if (jsonMode) {
      emitJsonError("unresolved skills", HINT_UNRESOLVED, {
        names: unresolved,
      });
      return 2;
    }
    console.error(`Unresolved: ${unresolved.join(", ")}`);
    return 2;
  }

  const changed = sortNames(
    new Set([
      ...delta.extra,
      ...delta.restore,
      ...delta.install,
      ...delta.remove,
    ])
  );
  if (changed.length === 0) {
    if (jsonMode) emitJson({ state, changed, applied: false });
    else console.log("No changes.");
    return 0;
  }
  if (jsonMode) emitJson({ state, changed, applied: false });
  const denied = confirmedAction(`Set ${state}`, changed, yes);
  if (denied) return denied;

  backupActiveToLast(lock);
  try {
    // 戻り値の warning は日本語。CLI は英語出力の規約なので、失敗の事実だけ出す。
    const warning = applyDeck(
      delta.extra,
      delta.restore,
      delta.install,
      lock,
      delta.remove
    );
    if (warning) console.error("warning: could not update the skills CLI lock");
  } catch (error) {
    return failFromError(error, "check skill state via status --json");
  }
  if (jsonMode) emitJson({ state, changed, applied: true });
  else console.log(`Set ${state}: ${changed.join(", ")}`);
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
  // `--json` では stdout をデータ専用にするため、プロンプトは stderr へ出す。
  (jsonMode ? process.stderr : process.stdout).write(question);
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
    if (!jsonMode) console.log("No presets.");
    return 0;
  }
  if (jsonMode) {
    for (const preset of presets)
      emitJson(
        preset.description
          ? {
              name: preset.name,
              skillCount: preset.skillCount,
              description: preset.description,
            }
          : { name: preset.name, skillCount: preset.skillCount }
      );
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
    return failFromError(error, HINT_DECK_PRESET);
  }
  if (jsonMode) emitJson({ name: saved.name, skills: saved.skills });
  else
    console.log(`Saved preset ${saved.name} (${saved.skills.length} skills)`);
  return 0;
}

function cmdPresetApply(args: PresetArgs): number {
  const lock = loadLock();
  let preview: ReturnType<typeof previewNamedPreset>;
  try {
    preview = previewNamedPreset(args.name, lock);
  } catch (error) {
    return failFromError(error, HINT_DECK_PRESET);
  }

  const plan = computePresetApplyPlan(new Set(preview.skills), lock);
  const planJson = (applied: boolean) => ({
    target: preview.skills,
    archive: sortNames(plan.extra),
    restore: sortNames(plan.restore),
    install: sortNames(plan.install),
    unresolved: sortNames(plan.unresolved),
    remove: sortNames(plan.remove),
    applied,
  });
  if (jsonMode) emitJson(planJson(false));
  else console.log(formatPresetApplyPreview(plan));
  if (preview.blocked) {
    if (jsonMode) {
      emitJsonError("unresolved skills", HINT_UNRESOLVED, {
        names: sortNames(plan.unresolved),
      });
    }
    return 2;
  }
  const denied = confirmProceed(args.yes, "Apply this preset? [y/N] ");
  if (denied) return denied;

  try {
    applyNamedPreset(args.name, lock, true);
  } catch (error) {
    return failFromError(error, HINT_DECK_PRESET);
  }
  if (jsonMode) emitJson(planJson(true));
  else console.log(`Applied preset: ${args.name}`);
  return 0;
}

function cmdPresetRestore(args: PresetArgs): number {
  const lock = loadLock();
  if (!hasPreviousPreset())
    return cliError(
      "no previous state saved",
      "presets save a snapshot before each apply/skill change",
      "No previous state saved"
    );

  // preview と同じ条件（_last のスナップショットへ戻す）で計画してから見せる。
  let plan: ReturnType<typeof computeSnapshotPlan>;
  let targetActive: string[] = [];
  try {
    const last = loadPreset(PRESET_LAST_NAME);
    targetActive = last.skills ?? [];
    plan = computeSnapshotPlan(
      new Set(targetActive),
      new Set(last.archive ?? []),
      lock
    );
  } catch (error) {
    return failFromError(error, HINT_DECK_PRESET);
  }
  const planJson = (applied: boolean) => ({
    target: targetActive,
    archive: sortNames(plan.extra),
    restore: sortNames(plan.restore),
    install: sortNames(plan.install),
    unresolved: sortNames(plan.unresolved),
    remove: sortNames(plan.remove),
    applied,
  });
  if (jsonMode) emitJson(planJson(false));
  else console.log(formatPresetApplyPreview(plan));
  if (plan.unresolved.size > 0) {
    if (jsonMode)
      emitJsonError("skip unresolved", HINT_UNRESOLVED, {
        names: sortNames(plan.unresolved),
      });
    else
      console.error(
        `skip unresolved: ${sortNames(plan.unresolved).join(", ")}`
      );
  }
  const denied = confirmProceed(
    args.yes,
    "Restore previous active set? [y/N] "
  );
  if (denied) return denied;

  try {
    restorePreviousPreset(lock);
  } catch (error) {
    return failFromError(error, HINT_DECK_PRESET);
  }
  if (jsonMode) emitJson(planJson(true));
  else console.log("Restored previous active set");
  return 0;
}

function cmdPresetDelete(args: PresetArgs): number {
  try {
    deletePreset(args.name);
  } catch (error) {
    return failFromError(error, HINT_DECK_PRESET);
  }
  if (jsonMode) emitJson({ deleted: args.name });
  else console.log(`Deleted preset: ${args.name}`);
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
      if (!args.name)
        return cliError(
          "missing required argument",
          `skill-loom preset ${subcommand}: the following arguments are required: name`
        );
      if (subcommand === "save") return cmdPresetSave(args);
      if (subcommand === "apply") return cmdPresetApply(args);
      return cmdPresetDelete(args);
    case "restore":
      return cmdPresetRestore(args);
    default:
      return cliError(
        "invalid choice",
        "usage: skill-loom preset {list,save,apply,restore,delete} ...",
        `skill-loom preset: invalid choice: ${subcommand ?? ""}`
      );
  }
}

const [command, ...rest] = jsonMode
  ? Bun.argv.slice(2).filter((arg) => arg !== "--json")
  : Bun.argv.slice(2);

/** `argparse` が出す usage 行。no-args / unknown command で共通して使う。 */
const USAGE =
  "usage: skill-loom [-h] {list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck,skill} ...";

/**
 * `argparse` の `--help`。1 文字まで移行前と合わせるので、画面の端で折れる幅も含めて
 * 固定文字列にしている（`link-agents` の説明が 80 桁で折れるのも再現）。
 */
const HELP = `usage: skill-loom [-h] {list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck,skill} ...

positional arguments:
  {list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck,skill}
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
    skill               Set named skills to active, archive, or off

options:
  -h, --help            show this help message and exit
`;

// argparse は `-h/--help` で stdout へ出して 0、サブコマンド無しで stderr へ 2。
if (command === "-h" || command === "--help") {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === undefined)
  process.exit(
    cliError(
      "missing required argument",
      USAGE,
      USAGE,
      "skill-loom: error: the following arguments are required: command"
    )
  );

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
    // argparse が出していた 2 行をそのまま再現する。
    if (rest.length !== 1 || !rest[0])
      process.exit(
        cliError(
          "missing required argument",
          "usage: skill-loom install-deck [-h] name",
          "usage: skill-loom install-deck [-h] name",
          "skill-loom install-deck: error: the following arguments are required: name"
        )
      );
    process.exit(cmdInstallDeck(rest[0]));
    break;
  case "link-agents":
    // argparse (nargs="+") が出していた 2 行をそのまま再現する。
    if (rest.length === 0)
      process.exit(
        cliError(
          "missing required argument",
          "usage: skill-loom link-agents [-h] names [names ...]",
          "usage: skill-loom link-agents [-h] names [names ...]",
          "skill-loom link-agents: error: the following arguments are required: names"
        )
      );
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
  case "skill":
    process.exit(cmdSkill(rest));
    break;
  default:
    // argparse の invalid choice。stdout ではなく stderr へ。
    process.exit(
      cliError(
        "invalid choice",
        USAGE,
        USAGE,
        `skill-loom: error: argument command: invalid choice: '${command}' (choose from list,status,all,install-deck,link-agents,ui,preset,external,custom,draft,deck,skill)`
      )
    );
}
