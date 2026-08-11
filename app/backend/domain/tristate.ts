/**
 * tristate（active / off / archive）の差分計算と適用結果メッセージ。
 *
 * `bin/my-skills.py` の `compute_tristate_apply_delta` /
 * `format_tristate_apply_summary` の移植。ここは副作用を持たない純粋な計算で、
 * 実際にファイルを動かすのは `projection.ts`。
 *
 * 差分計算を書き込みから切り離してあるのは、Apply の前に unresolved を検出して
 * 400 を返す必要があるため。1 つでも解決できない skill があれば、4 か所への
 * 書き込みは 1 バイトも起こしてはいけない。
 */

import {
  activeDir,
  archiveDir,
} from "./config"
import {
  ignoredSkills,
  type Lock,
  type Selection,
  sortNames,
  trackedSkills,
  visibleInstalledNames,
} from "./inventory"

export const TRISTATE_VALUES: ReadonlySet<string> = new Set(["off", "active", "archive"])

export type ApplyDelta = {
  extra: Set<string>
  restore: Set<string>
  install: Set<string>
  remove: Set<string>
  unresolved: Set<string>
}

/** リクエスト body の `states` から、値が tristate として妥当なものだけを拾う。 */
export function parseTristateStates(body: unknown): Record<string, Selection> {
  const raw = (body as { states?: unknown } | null)?.states
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}

  const states: Record<string, Selection> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const desired = String(value)
    if (TRISTATE_VALUES.has(desired)) states[String(key)] = desired as Selection
  }
  return states
}

function projectionState(name: string, active: Set<string>, archived: Set<string>): Selection {
  if (active.has(name)) return "active"
  if (archived.has(name)) return "archive"
  return "off"
}

export function computeTristateApplyDelta(states: Record<string, Selection>, lock: Lock): ApplyDelta {
  const currentActive = visibleInstalledNames(lock, activeDir())
  const currentArchive = visibleInstalledNames(lock, archiveDir())
  const managed = trackedSkills(lock)
  const unmanaged = ignoredSkills()
  const known = new Set([...managed, ...unmanaged, ...currentActive, ...currentArchive])

  const delta: ApplyDelta = {
    extra: new Set(),
    restore: new Set(),
    install: new Set(),
    remove: new Set(),
    unresolved: new Set(),
  }

  for (const [name, desired] of Object.entries(states)) {
    // 変化のない skill は触らない。ここで弾かないと、既に正しい状態のものまで
    // move や symlink 張り直しの対象になる。
    if (desired === projectionState(name, currentActive, currentArchive)) continue

    const inActive = currentActive.has(name)
    const inArchive = currentArchive.has(name)

    if (desired === "off") {
      if (inActive || inArchive) delta.remove.add(name)
      continue
    }

    if (desired === "active") {
      if (inArchive) delta.restore.add(name)
      else if (!inActive) {
        if (managed.has(name)) delta.install.add(name)
        else if (!known.has(name)) delta.unresolved.add(name)
      }
      continue
    }

    if (desired === "archive") {
      if (inActive) delta.extra.add(name)
      else if (inArchive) continue
      else if (managed.has(name)) {
        // 未 install のものを archive にするには、一度 install してから移す。
        delta.install.add(name)
        delta.extra.add(name)
      } else if (!known.has(name)) delta.unresolved.add(name)
    }
  }

  return delta
}

export function formatTristateApplySummary(
  extra: Set<string>,
  restore: Set<string>,
  install: Set<string>,
  remove: Set<string>,
): string {
  const changed = new Set([...extra, ...restore, ...install, ...remove])
  const parts: string[] = []

  if (restore.size > 0) parts.push(`復帰 ${restore.size}: ${sortNames(restore).join(", ")}`)
  if (install.size > 0) parts.push(`新規追加 ${install.size}: ${sortNames(install).join(", ")}`)
  if (extra.size > 0) parts.push(`archive ${extra.size}: ${sortNames(extra).join(", ")}`)
  if (remove.size > 0) parts.push(`off(除去) ${remove.size}: ${sortNames(remove).join(", ")}`)

  if (parts.length === 0) return "変更はありません"
  return `Applied (${changed.size} skill): ${parts.join("; ")}`
}
