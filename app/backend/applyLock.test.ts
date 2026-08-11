/**
 * Apply ロックのテスト。
 *
 * #74 で全ルートが TypeScript 側へ移り、proxy 手前でロックを取る仕組みは無くなった。
 * 残るのはハンドラ同士の相互排他だけ。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { releaseApply, tryAcquireApply } from "./applyLock"

afterEach(() => {
  releaseApply()
})

describe("排他制御", () => {
  test("2 本目は取れず、release すれば取り直せる", () => {
    expect(tryAcquireApply()).toBe(true)
    expect(tryAcquireApply()).toBe(false)

    releaseApply()
    expect(tryAcquireApply()).toBe(true)
  })
})

