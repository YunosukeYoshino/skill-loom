/**
 * plan-candidates — source の候補を UI と同じ規則で衝突判定し、1 行ずつ出す。
 *
 *   bun plan-candidates.ts <owner/repo> [skill...]
 *
 * skill を省略すると source の全候補を対象にする。出力は TSV:
 *   ok<TAB>name
 *   conflict<TAB>name<TAB>reason
 * 候補が取れない・lock が読めないときは非 0 で終わる（黙って 0 件扱いにしない）。
 */
import { resolveExternalCandidatesMapping } from "../../../../app/backend/domain/external";
import { existsSync, readFileSync } from "node:fs";
import { lockFile } from "../../../../app/backend/domain/config";
import type { Lock } from "../../../../app/backend/domain/inventory";
import { externalSkillCandidates } from "../../../../app/backend/infrastructure/github";

const [source, ...names] = process.argv.slice(2);
if (!source) {
  console.error("Usage: plan-candidates.ts <owner/repo> [skill...]");
  process.exit(2);
}
// 他の skills-add スクリプトと同じく、schema version を問わず custom/vendor/external だけ読む。
const path = lockFile();
const lock: Lock = existsSync(path)
  ? (JSON.parse(readFileSync(path, "utf-8")) as Lock)
  : {};
const candidates =
  names.length > 0
    ? names.map((name) => ({ name }))
    : externalSkillCandidates(source);
for (const row of resolveExternalCandidatesMapping(lock, source, candidates)) {
  console.log(
    row.conflict
      ? `conflict\t${row.upstreamName}\t${row.conflict}`
      : `ok\t${row.upstreamName}`
  );
}
