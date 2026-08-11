/**
 * Apply の多重実行を止める排他制御。
 *
 * 移行前は FastAPI 単一プロセスの `threading.Lock` 1 つが、projection を書き換える
 * 13 ルート全部を相互排他していた。#68 で `/api/apply` と `/api/bulk-off` だけが
 * TypeScript 側へ移るため、素直に Bun 側へロックを置くと「TS の Apply」と
 * 「Python の preset restore」が同時に走れてしまい、4 か所書き込みが互いを踏む。
 *
 * Hono が公開ポートを所有していて全リクエストがここを通るので、ロックは Hono 側に
 * 1 つだけ置く。移植が終わった今は、projection を書き換えるハンドラだけがここを触る。
 *
 * JS は単一スレッドで、`tryAcquire` の検査と代入の間に他のタスクが割り込まないため
 * boolean で足りる。
 */

let held = false

export function tryAcquireApply(): boolean {
  if (held) return false
  held = true
  return true
}

export function releaseApply(): void {
  held = false
}

export const APPLY_BUSY_MESSAGE = "Apply already running. Wait for the current apply to finish."

/**
 * 移植前は「FastAPI 側に残った書き込みルート」も、proxy へ入る手前でこのロックを
 * 取っていた（`needsApplyLock`）。#74 で最後の 2 本が TypeScript 側へ移り、
 * proxy を通る書き込みが 1 本も無くなったのでその仕組みごと畳んだ。
 */
