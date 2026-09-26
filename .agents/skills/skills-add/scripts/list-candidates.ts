// source に含まれる skill 名を 1 行ずつ出す。install 前に衝突判定するために使う。
import { externalSkillCandidates } from "../../../../app/backend/infrastructure/github";

const [source] = process.argv.slice(2);
if (!source) {
  console.error("Usage: list-candidates.ts <owner/repo>");
  process.exit(2);
}
for (const candidate of externalSkillCandidates(source)) {
  console.log(candidate.name);
}
