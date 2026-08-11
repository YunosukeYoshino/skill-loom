/**
 * Projection の書き込み経路。`bin/my-skills.py` の `apply_deck` 系の移植。
 *
 * ADR 0006 のとおり、projection から抜けることは 4 か所から抜けることを意味する。
 * Active ディレクトリ、Archive ディレクトリ、skills CLI の lock、そしてエージェントが
 * 実際に読む symlink ディレクトリ 2 種。1 か所でも取りこぼすと、
 *
 * - CLI lock を残す → 外部 CLI の update が Off にした skill を再インストールする
 * - symlink を残す → 実体が戻った瞬間にエージェントから見えてしまう
 *
 * `apply_deck` の手順の順序には意味がある。symlink を最初に全部外すのは、
 * 移動の途中経過をエージェントに見せないため。順序を変えないこと。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import {
  activeDir,
  archiveDir,
  claudeSkillsDir,
  geminiSkillsDir,
  GLOBAL_INSTALL_AGENTS,
  globalLockFile,
  PRESET_LAST_NAME,
  skillsAddBin,
  trashBin,
} from "./config"
import { resolveCatalogPath } from "./catalogPaths"
import { loadDeck } from "./decks"
import { ValueError } from "./errors"
import { type Lock, managedActiveSkills, sortNames, trackedSkills, visibleInstalledNames } from "./inventory"
import {
  backupActiveToLast,
  computePresetApplyPlan,
  loadPreset,
  NO_PREVIOUS_STATE_MESSAGE,
  presetLastExists,
  type PresetPlan,
  presetNowIso,
  validatePresetName,
  writePresetFile,
} from "./presets"

/** Python の `Path.exists()`。symlink を辿り、壊れた symlink では false。 */
function exists(path: string): boolean {
  return existsSync(path)
}

/** Python の `Path.is_symlink()`。リンク先の有無は問わない。 */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 削除は必ずゴミ箱経由。`rm -rf` にしないのは、Apply の誤爆が
 * ユーザーの skill を復元不能にするため。
 */
export function trashPath(path: string): void {
  if (!exists(path) && !isSymlink(path)) return
  const result = Bun.spawnSync([trashBin(), path])
  if (result.exitCode !== 0) {
    throw new Error(`trash failed (${result.exitCode}): ${path}`)
  }
}

/** エージェントが実際に読むディレクトリ。どちらも ACTIVE_DIR への symlink を張る。 */
function agentSkillDirs(): string[] {
  return [claudeSkillsDir(), geminiSkillsDir()]
}

export function linkAgentSkillDirs(name: string): void {
  const target = join(activeDir(), name)
  if (!exists(target)) return

  for (const agentDir of agentSkillDirs()) {
    mkdirSync(agentDir, { recursive: true })
    const link = join(agentDir, name)
    // 壊れた symlink は誰も張り直さないので、ここで落としてから張る。
    if (isSymlink(link) && !exists(link)) unlinkSync(link)
    if (exists(link) || isSymlink(link)) continue
    symlinkSync(relative(agentDir, target), link)
  }
}

export function linkAgentSkillDirsMany(names: Iterable<string>): void {
  for (const name of sortNames(new Set(names))) linkAgentSkillDirs(name)
}

/** symlink だけを外す。実体のディレクトリは別の何かが置いたものなので触らない。 */
export function unlinkAgentSkillDirs(name: string): void {
  for (const agentDir of agentSkillDirs()) {
    const link = join(agentDir, name)
    if (isSymlink(link)) unlinkSync(link)
  }
}

export function unlinkAgentSkillDirsMany(names: Iterable<string>): void {
  for (const name of sortNames(new Set(names))) unlinkAgentSkillDirs(name)
}

/**
 * skills CLI の lock から名前を落とす。
 *
 * CLI は実体の有無を見ずに自分の lock を辿るので、ここに残った skill は
 * 数日後の `skills update` で戻ってくる。書き換えられなかったときは警告文を返し、
 * 呼び出し側は処理を続ける（projection 自体は既に正しいため）。
 */
export function deregisterFromCliLock(names: Set<string>): string {
  const lockPath = globalLockFile()
  if (names.size === 0 || !exists(lockPath)) return ""

  let data: unknown
  try {
    data = JSON.parse(readFileSync(lockPath, "utf8"))
  } catch {
    return `CLI lock を更新できませんでした（読めない形式）: ${lockPath}`
  }

  const skills = (data as { skills?: unknown } | null)?.skills
  if (!data || typeof data !== "object" || Array.isArray(data) || !skills || typeof skills !== "object" || Array.isArray(skills)) {
    return `CLI lock を更新できませんでした（想定外の構造）: ${lockPath}`
  }

  const entries = skills as Record<string, unknown>
  const dropped = sortNames(names).filter((name) => name in entries)
  if (dropped.length === 0) return ""
  for (const name of dropped) delete entries[name]

  // tmp へ書いてから rename。途中で落ちても CLI lock が壊れた状態で残らない。
  const tmp = `${lockPath}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(tmp, lockPath)
  } catch (error) {
    return `CLI lock を更新できませんでした（書き込み失敗: ${error instanceof Error ? error.message : String(error)}）: ${lockPath}`
  }
  return ""
}

/** 外部 skill の install コマンド。source ごとに 1 コマンドへまとめる。 */
export function installCommands(missing: Set<string>, lock: Lock): string[][] {
  const external = lock.external ?? {}
  const bySource = new Map<string, string[]>()

  for (const name of sortNames(missing)) {
    const source = external[name]?.source
    if (!source) continue
    const names = bySource.get(source)
    if (names) names.push(name)
    else bySource.set(source, [name])
  }

  return sortNames(bySource.keys()).map((source) => {
    const cmd = [skillsAddBin(), "skills", "add", source]
    for (const name of bySource.get(source) ?? []) cmd.push("--skill", name)
    cmd.push("-g")
    for (const agent of GLOBAL_INSTALL_AGENTS) cmd.push("-a", agent)
    cmd.push("-y")
    return cmd
  })
}

export class ProjectionInstallError extends Error {}

export function runSkillsCli(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" })
  if (result.exitCode === 0) return

  // bunx が無い環境向けの逃げ道。Python 側と同じ条件でだけ npx に落とす。
  if (cmd[0] === "bunx" && Bun.which("npx")) {
    const fallback = ["npx", ...cmd.slice(1)]
    console.error(`+ ${fallback.join(" ")}  # bunx failed, retrying with npx`)
    const retry = Bun.spawnSync(fallback, { stdout: "inherit", stderr: "inherit" })
    if (retry.exitCode === 0) return
    throw new ProjectionInstallError(`skills CLI failed (${retry.exitCode}): ${fallback.join(" ")}`)
  }
  throw new ProjectionInstallError(`skills CLI failed (${result.exitCode}): ${cmd.join(" ")}`)
}

export function installCustomFromRepo(names: Set<string>, lock: Lock): void {
  const custom = lock.custom?.skills ?? {}
  mkdirSync(activeDir(), { recursive: true })
  mkdirSync(claudeSkillsDir(), { recursive: true })
  mkdirSync(geminiSkillsDir(), { recursive: true })

  for (const name of sortNames(names)) {
    // lock の値が文字列のこともある。移行前も dict 以外は repoPath なしとして飛ばす。
    const meta = custom[name]
    const repoPath = typeof meta === "string" ? null : meta?.repoPath
    if (!repoPath) continue

    const src = resolveCatalogPath(repoPath)
    const dst = join(activeDir(), name)
    if (!exists(src)) throw new ProjectionInstallError(`custom skill source not found: ${src}`)
    // dereference は Python の copytree(symlinks=False) 相当。
    try {
      if (!exists(dst)) cpSync(src, dst, { recursive: true, dereference: true })
    } catch (error) {
      throw new ProjectionInstallError(error instanceof Error ? error.message : String(error))
    }

    linkAgentSkillDirs(name)
  }
}

/**
 * ディレクトリを移す。`shutil.move` と同じく、跨ぐファイルシステムでは
 * コピーしてから元を捨てる。
 */
function movePath(src: string, dst: string): void {
  try {
    renameSync(src, dst)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    cpSync(src, dst, { recursive: true, verbatimSymlinks: true })
    trashPath(src)
  }
}

/**
 * projection を書き換える。CLI lock を更新できなかったときだけ警告文を返す。
 *
 * 手順の順序は Python 実装のまま。特に「symlink を先に全部外す」を後ろへ動かすと、
 * 移動の途中経過がエージェントから見えてしまう。
 */
export function applyDeck(
  extra: Set<string>,
  restore: Set<string>,
  install: Set<string>,
  lock: Lock,
  remove: Set<string> = new Set(),
): string {
  mkdirSync(activeDir(), { recursive: true })
  mkdirSync(archiveDir(), { recursive: true })

  const deregistered = new Set([...remove, ...extra])
  unlinkAgentSkillDirsMany(deregistered)

  for (const name of sortNames(remove)) {
    for (const base of [activeDir(), archiveDir()]) {
      const path = join(base, name)
      if (exists(path) || isSymlink(path)) trashPath(path)
    }
  }

  for (const name of sortNames(restore)) {
    const src = join(archiveDir(), name)
    const dst = join(activeDir(), name)
    if (exists(src) && !exists(dst)) {
      movePath(src, dst)
      linkAgentSkillDirs(name)
    }
  }

  const external = new Set(Object.keys(lock.external ?? {}))
  installCustomFromRepo(new Set([...install].filter((name) => !external.has(name))), lock)

  const externalInstall = new Set([...install].filter((name) => external.has(name)))
  for (const cmd of installCommands(externalInstall, lock)) {
    console.log(`+ ${cmd.join(" ")}`)
    runSkillsCli(cmd)
  }
  linkAgentSkillDirsMany([...externalInstall].filter((name) => exists(join(activeDir(), name))))

  for (const name of sortNames(extra)) {
    const src = join(activeDir(), name)
    const dst = join(archiveDir(), name)
    if (!exists(src)) continue
    if (exists(dst)) {
      trashPath(src)
      continue
    }
    movePath(src, dst)
  }

  // archive 直行の skill は上の install で symlink を張られている。張り直しではなく外す。
  unlinkAgentSkillDirsMany([...extra].filter((name) => install.has(name)))
  return deregisterFromCliLock(deregistered)
}

/**
 * preset の計画を projection に流し込む。
 *
 * install を tracked で絞るのは、lock に無い skill を preset の名前だけで
 * インストールしようとしないため（取得元が分からない）。
 */
export function applyPresetPlan(plan: PresetPlan, lock: Lock): string {
  const tracked = trackedSkills(lock)
  const install = new Set([...plan.install].filter((name) => tracked.has(name)))
  return applyDeck(new Set(), plan.restore, install, lock, plan.remove)
}

export type ProjectionIntent = {
  target: ReadonlySet<string>
  touchArchive?: boolean
}

export type ProjectionPlan = PresetPlan

export type ProjectionWarning = {
  kind: "cli-lock-update"
  detail: string
}

export type ProjectionInstallFailure = {
  kind: "install"
  detail: string
}

export type ProjectionOutcome = {
  applied: boolean
  plan: ProjectionPlan
  changed: ReadonlySet<string>
  unresolved: ReadonlySet<string>
  warning: ProjectionWarning | null
  installFailure: ProjectionInstallFailure | null
}

/** Projection の意図を preview と apply が共有する plan に変換する。 */
export function planProjection(intent: ProjectionIntent, lock: Lock): ProjectionPlan {
  return computePresetApplyPlan(new Set(intent.target), lock, intent.touchArchive ?? true)
}

/** 既存の Projection writer を通して plan を適用し、事実を outcome で返す。 */
export function applyProjectionPlan(plan: ProjectionPlan, lock: Lock): ProjectionOutcome {
  const changed = new Set([...plan.remove, ...plan.restore, ...plan.install])
  if (plan.unresolved.size > 0) {
    return {
      applied: false,
      plan,
      changed: new Set(),
      unresolved: new Set(plan.unresolved),
      warning: null,
      installFailure: null,
    }
  }

  try {
    const warning = applyPresetPlan(plan, lock)
    return {
      applied: true,
      plan,
      changed,
      unresolved: new Set(),
      warning: warning ? { kind: "cli-lock-update", detail: warning } : null,
      installFailure: null,
    }
  } catch (error) {
    if (!(error instanceof ProjectionInstallError)) throw error
    return {
      applied: false,
      plan,
      changed: new Set(),
      unresolved: new Set(),
      warning: null,
      installFailure: { kind: "install", detail: error.message },
    }
  }
}

/**
 * 任意の skill 集合を「これが active のすべて」という状態にする。
 *
 * `skipUnresolved` は Restore 専用の逃げ道。通常の apply では 1 つでも解決できない
 * skill があれば書き込む前に投げる。
 */
export function applyPresetTarget(
  target: Set<string>,
  lock: Lock,
  options: { backup?: boolean; touchArchive?: boolean; skipUnresolved?: boolean } = {},
): PresetPlan {
  const { backup = true, touchArchive = true, skipUnresolved = false } = options
  const plan = computePresetApplyPlan(target, lock, touchArchive)
  if (plan.unresolved.size > 0 && !skipUnresolved) {
    throw new ValueError(`Unresolved: ${sortNames(plan.unresolved).join(", ")}`)
  }
  if (backup) backupActiveToLast(lock)
  applyPresetPlan(plan, lock)
  return plan
}

export function applyNamedPreset(name: string, lock: Lock, backup = true): PresetPlan {
  validatePresetName(name)
  const preset = loadPreset(name)
  const skills = preset.skills ?? []
  if (skills.length === 0) throw new ValueError("Cannot apply preset: no skills in preset")
  return applyPresetTarget(new Set(skills), lock, { backup })
}

/**
 * 直前の active に戻す。戻したあとの `_last` には「戻す前の状態」を入れ直すので、
 * Restore をもう一度押すと元に戻る（トグルとして使える）。
 */
export function restorePreviousPreset(lock: Lock): PresetPlan {
  if (!presetLastExists()) throw new ValueError(NO_PREVIOUS_STATE_MESSAGE)
  const last = loadPreset(PRESET_LAST_NAME)
  const lastSkills = new Set(last.skills ?? [])
  // 書き換える前の active を控えておく。これが次の `_last` になる。
  const current = visibleInstalledNames(lock, activeDir())

  const plan = applyPresetTarget(lastSkills, lock, { backup: false, touchArchive: false, skipUnresolved: true })
  writePresetFile({ name: PRESET_LAST_NAME, skills: sortNames(current), updatedAt: presetNowIso() })
  return plan
}

/** 管理下の active だけを Off にする。未追跡と archive は触らない。 */
export function bulkOffActive(lock: Lock, backup = true): Set<string> {
  const active = managedActiveSkills(lock)
  if (active.size === 0) throw new ValueError("No managed active skills to turn off")
  if (backup) backupActiveToLast(lock)
  applyDeck(new Set(), new Set(), new Set(), lock, active)
  return active
}

export type ProjectDeckInstallResult = {
  unresolved: Set<string>
  restore: Set<string>
  install: Set<string>
  alreadyActive: Set<string>
}

/**
 * project deck の skill を active へ揃える（CLI の `install-deck`）。
 *
 * 取得元の分からない skill が 1 つでもあれば何も動かさない。半端に入れると、
 * どこまで入ったのかを利用者が追えなくなる。
 *
 * UI の Apply と違って off にはしない（`extra` は常に空）。deck に無い skill を
 * CLI から黙って落とすと、他の deck の作業中に足元が消える。
 */
export function installProjectDeck(deckName: string, lock: Lock): ProjectDeckInstallResult {
  const [, skills] = loadDeck(deckName, new Set(), true)
  const target = new Set(skills)
  const active = visibleInstalledNames(lock, activeDir())
  const archived = visibleInstalledNames(lock, archiveDir())
  const managed = trackedSkills(lock)
  const alreadyActive = new Set([...target].filter((name) => active.has(name)))

  const unresolved = new Set(
    [...target].filter((name) => !managed.has(name) && !active.has(name) && !archived.has(name)),
  )
  if (unresolved.size > 0) {
    return { unresolved, restore: new Set(), install: new Set(), alreadyActive }
  }

  const restore = new Set([...target].filter((name) => archived.has(name) && !active.has(name)))
  const install = new Set(
    [...target].filter((name) => !active.has(name) && !archived.has(name) && managed.has(name)),
  )
  applyDeck(new Set(), restore, install, lock)
  return { unresolved: new Set(), restore, install, alreadyActive }
}
