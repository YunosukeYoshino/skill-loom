/**
 * ドメイン層が投げる例外。
 *
 * 呼び出し側（HTTP ハンドラと CLI）が 400 / 409 / 500 と終了コードを区別するためだけに
 * 存在する。移行前の Python が使っていた組み込み例外に 1 対 1 で対応する。
 *
 * ここを `projection.ts` や `presets.ts` に置くと、両者が互いを import して循環するため
 * 独立したモジュールにしてある。
 */

/** Python の `ValueError`（`json.JSONDecodeError` を含む）。呼び出し側は 400。 */
export class ValueError extends Error {}

/** Python の `FileNotFoundError`。呼び出し側は 400。 */
export class NotFoundError extends Error {}

/** Python の `FileExistsError`。preset save / deck create が 409 に落とす。 */
export class AlreadyExistsError extends Error {}
