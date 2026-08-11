/**
 * Preset の検証・保存・計画づくりのテスト。
 *
 * `tests/test_skill_presets.py` の PresetPlanTests / PresetPersistenceTests に対応する。
 * 計画の中身を間違えると Apply が消してはいけないものを消すので、`remove` が
 * どこから来るかを 1 ケースずつ固定する。特に `touchArchive` は Restore 専用の
 * 逃げ道で、ここが true に倒れると Restore が archive を巻き添えにする。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AlreadyExistsError, NotFoundError, ValueError } from "./errors"
import type { Lock } from "./inventory"
import {
  computePresetApplyPlan,
  deletePreset,
  formatPresetApplyPreview,
  listUserPresets,
  loadPreset,
  presetPlanPreview,
  previewNamedPreset,
  previewRestorePrevious,
  savePresetFromActive,
  validatePresetName,
  writePresetFile,
} from "./presets"

let sandbox: string
const touched: string[] = []

const lock: Lock = {
  custom: {
    repo: "owner/catalog",
    skills: { keep: { repoPath: "skills/a/keep" }, drop: { repoPath: "skills/a/drop" } },
  },
  external: {},
}

function setEnv(name: string, value: string): void {
  touched.push(name)
  process.env[name] = value
}

const dir = (...parts: string[]) => join(sandbox, ...parts)

function place(where: "active" | "archive", ...names: string[]): void {
  for (const name of names) mkdirSync(dir(where, name), { recursive: true })
}

/** Set の比較は並びを固定してから。 */
function sorted(names: Set<string>): string[] {
  return [...names].sort()
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "my-skills-presets-"))
  for (const sub of ["active", "archive", "presets"]) mkdirSync(dir(sub), { recursive: true })
  setEnv("MY_SKILLS_ACTIVE_DIR", dir("active"))
  setEnv("MY_SKILLS_ARCHIVE_DIR", dir("archive"))
  setEnv("MY_SKILLS_PRESETS_DIR", dir("presets"))
  setEnv("MY_SKILLS_IGNORE_FILE", dir("ignore.json"))
})

afterEach(() => {
  for (const name of touched) delete process.env[name]
  touched.length = 0
  rmSync(sandbox, { recursive: true, force: true })
})

describe("validatePresetName", () => {
  test("`_last` はユーザーからは指定させない", () => {
    expect(() => validatePresetName("_last")).toThrow("Reserved preset name: _last")
    expect(() => validatePresetName("_last", true)).not.toThrow()
  })

  test("空・65 文字以上・使えない文字は弾く", () => {
    for (const name of ["", "a".repeat(65), "Daily", "-daily", "daily-", "daily_set"]) {
      expect(() => validatePresetName(name)).toThrow("Invalid preset name")
    }
  })

  test("英小文字・数字・ハイフンは通る", () => {
    for (const name of ["a", "daily", "deck-2026", "a".repeat(64)]) {
      expect(() => validatePresetName(name)).not.toThrow()
    }
  })
})

describe("loadPreset", () => {
  test("無ければ NotFoundError（呼び出し側は 400）", () => {
    expect(() => loadPreset("missing")).toThrow(NotFoundError)
  })

  test("壊れた JSON も skills の型崩れも ValueError", () => {
    writeFileSync(dir("presets", "broken.json"), "{ not json")
    writeFileSync(dir("presets", "typed.json"), JSON.stringify({ name: "typed", skills: [1, 2] }))

    expect(() => loadPreset("broken")).toThrow(ValueError)
    expect(() => loadPreset("typed")).toThrow(ValueError)
  })
})

describe("savePresetFromActive", () => {
  test("active が空なら保存しない（戻せない preset を作らない）", () => {
    expect(() => savePresetFromActive("daily", lock)).toThrow("Cannot save preset: no active skills")
  })

  test("保存され、description が空ならキーごと省かれる", () => {
    place("active", "keep", "drop")

    const saved = savePresetFromActive("daily", lock)
    expect(saved.skills).toEqual(["drop", "keep"])
    expect(saved.description).toBeUndefined()
    expect(readFileSync(dir("presets", "daily.json"), "utf-8")).not.toContain("description")

    const listed = listUserPresets()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe("daily")
    // 保存は `_last` を書かない。書いてしまうと Restore が保存前に戻してしまう。
    expect(existsSync(dir("presets", "_last.json"))).toBe(false)
  })

  test("同名は overwrite が無ければ AlreadyExistsError（409 の材料）", () => {
    place("active", "keep")
    savePresetFromActive("daily", lock)

    expect(() => savePresetFromActive("daily", lock)).toThrow(AlreadyExistsError)
    expect(() => savePresetFromActive("daily", lock, "二度目", true)).not.toThrow()
    expect(loadPreset("daily").description).toBe("二度目")
  })

  test("`_last` の名前では保存できない", () => {
    place("active", "keep")
    expect(() => savePresetFromActive("_last", lock)).toThrow(ValueError)
  })
})

describe("deletePreset", () => {
  test("消す。無ければ NotFoundError、`_last` は拒否", () => {
    place("active", "keep")
    savePresetFromActive("daily", lock)

    deletePreset("daily")
    expect(existsSync(dir("presets", "daily.json"))).toBe(false)
    expect(() => deletePreset("daily")).toThrow(NotFoundError)
    expect(() => deletePreset("_last")).toThrow(ValueError)
  })
})

describe("computePresetApplyPlan", () => {
  test("target に無いものは archive ではなく off（remove）になる", () => {
    place("active", "keep", "drop")
    place("archive", "archived")

    const plan = computePresetApplyPlan(new Set(["keep"]), lock)
    expect(sorted(plan.remove)).toEqual(["archived", "drop"])
    expect(sorted(plan.restore)).toEqual([])
    expect(sorted(plan.install)).toEqual([])
    expect(sorted(plan.unresolved)).toEqual([])
    expect(sorted(plan.becomeActive)).toEqual([])
  })

  test("archive にあるものは restore、どこにも無い管理下は install", () => {
    place("archive", "keep")

    const plan = computePresetApplyPlan(new Set(["keep", "drop"]), lock)
    expect(sorted(plan.restore)).toEqual(["keep"])
    expect(sorted(plan.install)).toEqual(["drop"])
    expect(sorted(plan.becomeActive)).toEqual(["drop", "keep"])
  })

  test("lock にもディスクにも無い名前は unresolved", () => {
    expect(sorted(computePresetApplyPlan(new Set(["missing-skill"]), lock).unresolved)).toEqual(["missing-skill"])
  })

  test("空の target は「全部 off」で、Restore の初期状態として成立する", () => {
    place("active", "keep")

    const plan = computePresetApplyPlan(new Set(), lock)
    expect(sorted(plan.remove)).toEqual(["keep"])
    expect(sorted(plan.becomeActive)).toEqual([])
  })

  test("touchArchive=false は archive と未追跡の active を remove から外す", () => {
    place("active", "keep", "ghost-untracked")
    place("archive", "archived")

    // Restore はこの経路。archive を掃除しないので `archived` は残り、
    // lock に無い `ghost-untracked` も巻き添えにしない。
    const plan = computePresetApplyPlan(new Set(["keep"]), lock, false)
    expect(sorted(plan.remove)).toEqual([])

    const touching = computePresetApplyPlan(new Set(["keep"]), lock)
    expect(sorted(touching.remove)).toEqual(["archived", "ghost-untracked"])
  })
})

describe("preview", () => {
  test("plan は active / off / install / unresolved に並べ替えられる", () => {
    place("active", "drop")
    place("archive", "keep")

    // 未知の skill は install にも unresolved にも出る。unresolved がある限り
    // Apply は止まるので、install 側に混ざっていても実際には流れない。
    const preview = presetPlanPreview(computePresetApplyPlan(new Set(["keep", "ghost"]), lock))
    expect(preview).toEqual({ active: ["ghost", "keep"], off: ["drop"], install: ["ghost"], unresolved: ["ghost"] })
  })

  test("変化が無ければ「変更はありません」", () => {
    place("active", "keep")
    expect(formatPresetApplyPreview(computePresetApplyPlan(new Set(["keep"]), lock))).toBe("変更はありません")
  })

  test("表示は active → off → install → unresolved の順", () => {
    place("active", "drop")
    place("archive", "keep")

    expect(formatPresetApplyPreview(computePresetApplyPlan(new Set(["keep", "ghost"]), lock))).toBe(
      [
        "active になる (2): ghost, keep",
        "off になる (1): drop",
        "install される (1): ghost",
        "unresolved (1): ghost",
      ].join("\n"),
    )
  })

  test("unresolved があれば blocked", () => {
    writePresetFile({ name: "daily", skills: ["ghost"], updatedAt: "2026-01-01T00:00:00+09:00" })
    expect(previewNamedPreset("daily", lock).blocked).toBe(true)
  })

  test("skill が 1 つも入っていない preset は当てられない", () => {
    writePresetFile({ name: "empty", skills: [], updatedAt: "2026-01-01T00:00:00+09:00" })
    expect(() => previewNamedPreset("empty", lock)).toThrow("Cannot apply preset: no skills in preset")
  })
})

describe("previewRestorePrevious", () => {
  test("`_last` が無ければ ValueError", () => {
    expect(() => previewRestorePrevious(lock)).toThrow("No previous state saved")
  })

  test("解決できない skill があっても blocked にしない（止めると二度と戻れない）", () => {
    writePresetFile({ name: "_last", skills: ["keep", "ghost"], updatedAt: "2026-01-01T00:00:00+09:00" })

    const preview = previewRestorePrevious(lock)
    expect(preview.name).toBe("_last")
    expect(preview.description).toBe("")
    expect(preview.preview.unresolved).toEqual(["ghost"])
    expect(preview.blocked).toBe(false)
  })
})
