#!/usr/bin/env bun
/**
 * CLI の入口。`./my-skills` の全サブコマンドを処理する（#75 で Python 版から一本化）。
 *
 * 出力は移行前の `bin/my-skills.py` の `cmd_*` と 1 文字も変えない。
 *
 * preset は Web UI と同じ `domain/presets.ts` と `domain/projection.ts` を呼ぶ。
 * CLI と UI で業務ルールを二重に持たないこと（ADR 0007）。
 */

import { readSync } from "node:fs"
import { listProjectDecks, loadDeck, UnknownDeckError } from "./domain/decks"
import {
  activeDir,
  archiveDir,
} from "./domain/config"
import {
  ignoredSkills,
  loadLock,
  sortNames,
  trackedSkills,
  visibleInstalledNames,
} from "./domain/inventory"
import {
  computePresetApplyPlan,
  formatPresetApplyPreview,
  deletePreset,
  hasPreviousPreset,
  listUserPresets,
  previewNamedPreset,
  previewRestorePrevious,
  savePresetFromActive,
} from "./domain/presets"
import { applyDeck, applyNamedPreset, installProjectDeck, linkAgentSkillDirsMany, restorePreviousPreset } from "./domain/projection"

/** Python の `f"{value:<width}"`。 */
function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

/** Python の `f"{value:>width}"`（数値の既定は右寄せ）。 */
function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value
}

function difference(base: Set<string>, ...others: Set<string>[]): Set<string> {
  const out = new Set(base)
  for (const other of others) for (const name of other) out.delete(name)
  return out
}

function cmdList(): number {
  const decks = listProjectDecks()
  if (decks.length === 0) {
    console.log("No project decks.")
    return 0
  }
  console.log("Project decks:")
  for (const name of decks) {
    const [deck, skills] = loadDeck(name, new Set(), true)
    console.log(`${padRight(name, 24)} ${padLeft(String(skills.length), 3)}  ${deck.description ?? ""}`)
  }
  return 0
}

function cmdStatus(): number {
  const lock = loadLock()
  const known = trackedSkills(lock)
  const unmanaged = ignoredSkills()
  const active = visibleInstalledNames(lock, activeDir())
  const archived = visibleInstalledNames(lock, archiveDir())

  console.log(`tracked:  ${known.size}`)
  console.log(`ignored:  ${unmanaged.size}`)
  console.log(`active:   ${active.size}`)
  console.log(`archive:  ${archived.size}`)
  console.log("")

  const untracked = difference(active, known, unmanaged)
  if (untracked.size > 0) {
    console.log("untracked active skills:")
    for (const name of sortNames(untracked)) console.log(`  ${name}`)
  } else {
    console.log("All active skills are tracked.")
  }
  return 0
}

/** `print_plan` の移植。`--apply` で使うため計算した各集合も返す。 */
function printPlan(
  target: Set<string>,
  lock: ReturnType<typeof loadLock>,
): { unresolved: boolean; extra: Set<string>; restore: Set<string>; install: Set<string>; known: Set<string> } {
  const active = visibleInstalledNames(lock, activeDir())
  const archived = visibleInstalledNames(lock, archiveDir())
  const managed = trackedSkills(lock)
  const unmanaged = ignoredSkills()
  const known = new Set([...managed, ...unmanaged])

  const unresolved = difference(target, known, active, archived)
  const extra = difference(active, target)
  const restore = difference(new Set([...target].filter((n) => archived.has(n))), active)
  const install = difference(target, active, archived, unmanaged)
  const unmanagedMissing = difference(new Set([...target].filter((n) => unmanaged.has(n))), active, archived)

  console.log(`active:   ${active.size}`)
  console.log(`target:   ${target.size}`)
  console.log(`archive:  ${archived.size}`)
  console.log("")

  if (unresolved.size > 0) {
    console.log("unresolved target skills:")
    for (const name of sortNames(unresolved)) console.log(`  ${name}`)
    console.log("")
  }

  const section = (label: string, names: Set<string>): void => {
    console.log(`${label} ${names.size}`)
    for (const name of sortNames(names)) console.log(`  ${name}`)
  }

  section("move to archive:", extra)
  console.log("")
  section("restore from archive:", restore)
  console.log("")
  section("install missing:", install)
  console.log("")
  section("unmanaged missing:", unmanagedMissing)

  return { unresolved: unresolved.size > 0, extra, restore, install, known }
}

/**
 * `all`。tracked skill を全件 active へ揃える。
 *
 * `--apply` が無ければ dry-run。`--apply` があれば `apply_deck(extra, restore, install & known)`
 * と同じ projection を走らせる。`install & known` は「管理対象に限る」の念押し（移行前どおり）。
 */
function cmdAll(argv: string[]): number {
  const lock = loadLock()
  const plan = printPlan(trackedSkills(lock), lock)
  if (plan.unresolved) return 2
  const apply = argv.includes("--apply")
  if (!apply) {
    console.log("")
    console.log("dry-run only; add --apply to restore all tracked skills")
    return 0
  }
  const installKnown = new Set([...plan.install].filter((name) => plan.known.has(name)))
  applyDeck(plan.extra, plan.restore, installKnown, lock)
  return 0
}

/**
 * `link-agents`。指定 skill の agent symlink を張る。
 *
 * install 系が内部で呼ぶ `link_agent_skill_dirs_many` を単体で出す、保守用の抜け道。
 */
function cmdLinkAgents(names: string[]): number {
  linkAgentSkillDirsMany(names)
  return 0
}

/**
 * `install-deck`。deck の skill を active へ揃える。
 *
 * 取得元の分からない skill が 1 つでもあれば、何も動かさずに 2 で抜ける。
 * 半端に入れると、どこまで入ったのかを利用者が追えなくなる。
 */
function cmdInstallDeck(name: string): number {
  const lock = loadLock()
  let result: ReturnType<typeof installProjectDeck>
  try {
    result = installProjectDeck(name, lock)
  } catch (error) {
    // 移行前は `SystemExit(f"Unknown project deck: ...")`。メッセージだけ出して 1 で抜ける。
    if (!(error instanceof UnknownDeckError)) throw error
    console.error(errorText(error))
    return 1
  }
  if (result.unresolved.size > 0) {
    console.log("unresolved deck skills:")
    for (const skill of sortNames(result.unresolved)) console.log(`  ${skill}`)
    return 2
  }
  console.log(`deck:           ${name}`)
  console.log(`already active: ${result.alreadyActive.size}`)
  console.log(`restored:       ${result.restore.size}`)
  console.log(`installed:      ${result.install.size}`)
  return 0
}

// ---- preset ----

/** 例外を `str(exc)` 相当の 1 行にする。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Python の `input()` 相当。プロンプトを改行なしで出し、1 行読む。
 *
 * 1 バイトずつ読むのは、返事の後ろに続く入力を食べてしまわないため。
 * EOF は空文字を返し、呼び出し側では「y ではない」= 中止になる。
 */
function askLine(question: string): string {
  process.stdout.write(question)
  const byte = Buffer.alloc(1)
  let line = ""
  while (true) {
    let read = 0
    try {
      read = readSync(0, byte, 0, 1, null)
    } catch {
      break
    }
    if (read === 0) break
    const char = byte.toString("utf8")
    if (char === "\n") break
    line += char
  }
  return line
}

function confirmed(question: string): boolean {
  const answer = askLine(question).trim().toLowerCase()
  return answer === "y" || answer === "yes"
}

function cmdPresetList(): number {
  const presets = listUserPresets()
  if (presets.length === 0) {
    console.log("No presets.")
    return 0
  }
  for (const preset of presets) {
    const suffix = preset.description ? `  ${preset.description}` : ""
    console.log(`${padRight(preset.name, 24)} ${padLeft(String(preset.skillCount), 3)}${suffix}`)
  }
  return 0
}

function cmdPresetSave(args: PresetArgs): number {
  let saved: ReturnType<typeof savePresetFromActive>
  try {
    saved = savePresetFromActive(args.name, loadLock(), args.description, args.overwrite)
  } catch (error) {
    console.error(errorText(error))
    return 2
  }
  console.log(`Saved preset ${saved.name} (${saved.skills.length} skills)`)
  return 0
}

function cmdPresetApply(args: PresetArgs): number {
  const lock = loadLock()
  let preview: ReturnType<typeof previewNamedPreset>
  try {
    preview = previewNamedPreset(args.name, lock)
  } catch (error) {
    console.error(errorText(error))
    return 2
  }

  console.log(formatPresetApplyPreview(computePresetApplyPlan(new Set(preview.skills), lock)))
  if (preview.blocked) return 2
  if (!args.yes && !confirmed("Apply this preset? [y/N] ")) {
    console.log("Aborted.")
    return 1
  }

  try {
    applyNamedPreset(args.name, lock, true)
  } catch (error) {
    console.error(errorText(error))
    return 2
  }
  console.log(`Applied preset: ${args.name}`)
  return 0
}

function cmdPresetRestore(args: PresetArgs): number {
  const lock = loadLock()
  if (!hasPreviousPreset()) {
    console.error("No previous state saved")
    return 2
  }

  let preview: ReturnType<typeof previewRestorePrevious>
  try {
    preview = previewRestorePrevious(lock)
  } catch (error) {
    console.error(errorText(error))
    return 2
  }

  // preview と同じ条件（archive は触らない）で計画し直してから見せる。
  const plan = computePresetApplyPlan(new Set(preview.skills), lock, false)
  console.log(formatPresetApplyPreview(plan))
  if (plan.unresolved.size > 0) console.error(`skip unresolved: ${sortNames(plan.unresolved).join(", ")}`)
  if (!args.yes && !confirmed("Restore previous active set? [y/N] ")) {
    console.log("Aborted.")
    return 1
  }

  try {
    restorePreviousPreset(lock)
  } catch (error) {
    console.error(errorText(error))
    return 2
  }
  console.log("Restored previous active set")
  return 0
}

function cmdPresetDelete(args: PresetArgs): number {
  try {
    deletePreset(args.name)
  } catch (error) {
    console.error(errorText(error))
    return 2
  }
  console.log(`Deleted preset: ${args.name}`)
  return 0
}

type PresetArgs = { name: string; description: string; overwrite: boolean; yes: boolean }

/** argparse の `preset` サブパーサ相当。位置引数は name 1 つだけ。 */
function parsePresetArgs(argv: string[]): PresetArgs {
  const args: PresetArgs = { name: "", description: "", overwrite: false, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--description") args.description = argv[++i] ?? ""
    else if (arg.startsWith("--description=")) args.description = arg.slice("--description=".length)
    else if (arg === "--overwrite") args.overwrite = true
    else if (arg === "-y" || arg === "--yes") args.yes = true
    else if (!args.name) args.name = arg
  }
  return args
}

function cmdPreset(argv: string[]): number {
  const [subcommand, ...rest] = argv
  const args = parsePresetArgs(rest)

  switch (subcommand) {
    case "list":
      return cmdPresetList()
    case "save":
    case "apply":
    case "delete":
      if (!args.name) {
        console.error(`my-skills preset ${subcommand}: the following arguments are required: name`)
        return 2
      }
      if (subcommand === "save") return cmdPresetSave(args)
      if (subcommand === "apply") return cmdPresetApply(args)
      return cmdPresetDelete(args)
    case "restore":
      return cmdPresetRestore(args)
    default:
      console.error(`my-skills preset: invalid choice: ${subcommand ?? ""}`)
      return 2
  }
}

const [command, ...rest] = Bun.argv.slice(2)

/** `argparse` が出す usage 行。no-args / unknown command で共通して使う。 */
const USAGE = "usage: my-skills [-h] {list,status,all,install-deck,link-agents,ui,preset} ..."

/**
 * `argparse` の `--help`。1 文字まで移行前と合わせるので、画面の端で折れる幅も含めて
 * 固定文字列にしている（`link-agents` の説明が 80 桁で折れるのも再現）。
 */
const HELP = `usage: my-skills [-h] {list,status,all,install-deck,link-agents,ui,preset} ...

positional arguments:
  {list,status,all,install-deck,link-agents,ui,preset}
    list                List project decks
    status              Show active/archive state
    all                 Preview or restore all tracked skills
    install-deck        Install project deck skills into active global skills
    link-agents         Symlink ~/.claude/skills and ~/.gemini/config/skills
                        to ~/.agents/skills
    ui                  Start a local HTML checklist for active skills
    preset              Manage local global skill presets

options:
  -h, --help            show this help message and exit
`

// argparse は `-h/--help` で stdout へ出して 0、サブコマンド無しで stderr へ 2。
if (command === "-h" || command === "--help") {
  process.stdout.write(HELP)
  process.exit(0)
}
if (command === undefined) {
  console.error(USAGE)
  console.error("my-skills: error: the following arguments are required: command")
  process.exit(2)
}

switch (command) {
  case "list":
    process.exit(cmdList())
    break
  case "status":
    process.exit(cmdStatus())
    break
  case "all":
    process.exit(cmdAll(rest))
    break
  case "install-deck":
    if (rest.length !== 1 || !rest[0]) {
      // argparse が出していた 2 行をそのまま再現する。
      console.error("usage: my-skills install-deck [-h] name")
      console.error("my-skills install-deck: error: the following arguments are required: name")
      process.exit(2)
    }
    process.exit(cmdInstallDeck(rest[0]))
    break
  case "link-agents":
    if (rest.length === 0) {
      // argparse (nargs="+") が出していた 2 行をそのまま再現する。
      console.error("usage: my-skills link-agents [-h] names [names ...]")
      console.error("my-skills link-agents: error: the following arguments are required: names")
      process.exit(2)
    }
    process.exit(cmdLinkAgents(rest))
    break
  case "preset":
    process.exit(cmdPreset(rest))
    break
  default:
    // argparse の invalid choice。stdout ではなく stderr へ。
    console.error(USAGE)
    console.error(
      `my-skills: error: argument command: invalid choice: '${command}' (choose from list,status,all,install-deck,link-agents,ui,preset)`,
    )
    process.exit(2)
}
