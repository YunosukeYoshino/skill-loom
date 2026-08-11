/**
 * Projection 先と lock ファイルの解決。
 *
 * ここが唯一のサンドボックス契約であり、テストは環境変数でこれらを差し替えることで
 * 開発者本人の `~/.agents` や `~/.claude` に触れずに済んでいる。移行前の
 * `bin/my-skills.py` の module 定数と 1 対 1 で対応させること。1 つでも既定値へ
 * フォールバックすると、テストが実際のホーム環境を破壊する。
 *
 * Python は import 時に定数として確定させているが、こちらは都度読む。サーバは
 * 環境変数を固定して起動するため挙動は同じで、テストからは差し替えやすくなる。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** 環境変数が空文字のときは未設定として既定へ倒す（Python の `os.environ.get` + or と同じ）。 */
function envPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? value : fallback;
}

/** Inventory と authored assets を保持する Catalog。未指定時は従来の同居 root。 */
export function catalogRoot(): string {
  return envPath("MY_SKILLS_CATALOG_DIR", REPO_ROOT);
}

/** 明示的な CLI Catalog は artifact-specific override より優先する。 */
function catalogFile(envName: string, relativePath: string): string {
  const selected = process.env.MY_SKILLS_CATALOG_DIR;
  if (process.env.MY_SKILLS_CATALOG_EXPLICIT === "1" && selected)
    return join(selected, relativePath);
  return envPath(envName, join(catalogRoot(), relativePath));
}

// ---- lock ----

export function lockFile(): string {
  return catalogFile("MY_SKILLS_LOCK_FILE", "skills.lock.json");
}

export function ignoreFile(): string {
  return catalogFile("MY_SKILLS_IGNORE_FILE", ".skills-ignore.json");
}

/** skills CLI 側の lock。my-skills の inventory lock とは別物なので取り違えない。 */
export function globalLockFile(): string {
  return envPath(
    "MY_SKILLS_GLOBAL_LOCK_FILE",
    join(homedir(), ".agents", ".skill-lock.json")
  );
}

// ---- projection 先 ----

export function activeDir(): string {
  return envPath("MY_SKILLS_ACTIVE_DIR", join(homedir(), ".agents", "skills"));
}

export function archiveDir(): string {
  return envPath(
    "MY_SKILLS_ARCHIVE_DIR",
    join(homedir(), ".agents", "skills-archive")
  );
}

export function claudeSkillsDir(): string {
  return envPath(
    "MY_SKILLS_CLAUDE_SKILLS_DIR",
    join(homedir(), ".claude", "skills")
  );
}

export function geminiSkillsDir(): string {
  return envPath(
    "MY_SKILLS_GEMINI_SKILLS_DIR",
    join(homedir(), ".gemini", "config", "skills")
  );
}

export function presetsDir(): string {
  return envPath(
    "MY_SKILLS_PRESETS_DIR",
    join(homedir(), ".agents", "skill-presets")
  );
}

// ---- deck ----

export function projectDecksDir(): string {
  return catalogFile("MY_SKILLS_PROJECT_DECKS_DIR", "project-decks");
}

/** Core Deck を含む共有 Deck。内容は Catalog が所有する。 */
export function decksDir(): string {
  return join(catalogRoot(), "shared-decks");
}

/** リポジトリ運用専用の skill。global 一覧には出さない。 */
export const REPO_LOCAL_SKILLS_DIR = join(REPO_ROOT, ".agents", "skills");

/** `/new-skill` が置く Draft Skill。`{category}/{name}/SKILL.md` の 2 階層。 */
export function draftSkillsDir(): string {
  return join(catalogRoot(), "drafts", "skills");
}

export const PRESET_LAST_NAME = "_last";

// ---- 外部 CLI ----

/**
 * 外部 skill を install する CLI。`MY_SKILLS_ADD_BIN` が未設定なら
 * `MY_SKILLS_UPDATE_BIN`、それも無ければ `bunx`。Python 側と同じ 2 段の既定。
 */
export function skillsAddBin(): string {
  return envPath("MY_SKILLS_ADD_BIN", envPath("MY_SKILLS_UPDATE_BIN", "bunx"));
}

/**
 * 外部 skill の取り込みに使う `skills-add` スクリプト。`skillsAddBin` の
 * `bunx skills add` と違い、候補の解決から lock 更新までを一括で面倒を見る。
 */
export function skillsAddScript(): string {
  return envPath(
    "MY_SKILLS_ADD_SCRIPT",
    join(REPO_LOCAL_SKILLS_DIR, "skills-add", "scripts", "skills-add")
  );
}

export function skillsUpdateBin(): string {
  return envPath("MY_SKILLS_UPDATE_BIN", "bunx");
}

export function skillsRemoveBin(): string {
  return envPath("MY_SKILLS_REMOVE_BIN", "bunx");
}

/** Recoverable deletion adapter. Tests can replace the macOS Trash command. */
export function trashBin(): string {
  return envPath("MY_SKILLS_TRASH_BIN", "/usr/bin/trash");
}

/** `skills add` に渡すエージェント。install 先の symlink を CLI 自身が張る。 */
export const GLOBAL_INSTALL_AGENTS = [
  "claude-code",
  "codex",
  "antigravity",
] as const;

// ---- 外部 skill の候補取得と更新確認 ----

/**
 * 設定されていれば、GitHub を叩く代わりにこの JSON を候補一覧として読む。
 * E2E テストがネットワークに出ないための唯一の逃げ道。
 */
export function externalCandidatesFile(): string {
  return process.env.MY_SKILLS_EXTERNAL_CANDIDATES_FILE || "";
}

/** 数値の環境変数を下限付きで読む。壊れた値は既定へ倒す（Python の int() は落ちるが実害が無い）。 */
function envInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Math.max(minimum, Number.isNaN(parsed) ? fallback : parsed);
}

/** 更新確認の同時実行数。source が増えても一覧表示が遅くならないための並列度。 */
export function externalUpdateCheckWorkers(): number {
  return envInt("MY_SKILLS_UPDATE_CHECK_WORKERS", 16, 1);
}

/** GitHub への 1 リクエストのタイムアウト（秒）。 */
export function remoteSkillFetchTimeout(): number {
  return envInt("MY_SKILLS_REMOTE_SKILL_FETCH_TIMEOUT", 30, 5);
}

/**
 * `bunx skills` が SKILL.md を探す順序。ここが CLI とズレると、更新確認だけが
 * 別の SKILL.md を見て「更新あり」を出し続ける。
 */
export const CLI_SKILL_MD_PRIORITY_PREFIXES = [
  "",
  "skills/",
  "skills/.curated/",
  "skills/.experimental/",
  "skills/.system/",
  ".agents/skills/",
  ".claude/skills/",
  ".cline/skills/",
  ".codebuddy/skills/",
  ".codex/skills/",
  ".commandcode/skills/",
  ".continue/skills/",
  ".github/skills/",
  ".goose/skills/",
  ".iflow/skills/",
  ".junie/skills/",
  ".kilocode/skills/",
  ".kiro/skills/",
  ".mux/skills/",
  ".neovate/skills/",
  ".opencode/skills/",
  ".openhands/skills/",
  ".pi/skills/",
  ".qoder/skills/",
  ".roo/skills/",
  ".trae/skills/",
  ".windsurf/skills/",
  ".zencoder/skills/",
] as const;
