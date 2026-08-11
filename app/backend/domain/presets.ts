/**
 * Preset ファイルの読み書きと、apply の計画づくり。
 *
 * `bin/my-skills.py` の preset 系関数の移植。ここには副作用のうち
 * 「preset ファイルそのものへの書き込み」しか置かない。projection（active /
 * archive / CLI lock / symlink）を動かすのは `projection.ts` の役目で、
 * そちらがこのモジュールを import する。逆向きの import を足すと循環する。
 *
 * 計画（`computePresetApplyPlan`）を適用から切り離してあるのは、preview を
 * 出すためと、unresolved があるときに 1 バイトも書かずに 400 を返すため。
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { activeDir, archiveDir, PRESET_LAST_NAME, presetsDir } from "./config";
import { AlreadyExistsError, NotFoundError, ValueError } from "./errors";
import {
  ignoredSkills,
  installedNames,
  type Lock,
  managedActiveSkills,
  sortNames,
  trackedSkills,
  visibleInstalledNames,
} from "./inventory";

export type PresetSummary = {
  name: string;
  description: string;
  skillCount: number;
  updatedAt: string;
};

export type PresetData = {
  name: string;
  skills: string[];
  updatedAt?: string;
  description?: string;
};

export type PresetPlan = {
  remove: Set<string>;
  restore: Set<string>;
  install: Set<string>;
  unresolved: Set<string>;
  becomeActive: Set<string>;
};

export type PresetPreview = {
  name: string;
  description: string;
  skills: string[];
  preview: {
    active: string[];
    off: string[];
    install: string[];
    unresolved: string[];
  };
  blocked: boolean;
};

/** Restore の入口が 3 か所（HTTP・CLI・projection）あるので文言を 1 か所に置く。 */
export const NO_PREVIOUS_STATE_MESSAGE = "No previous state saved";

const PRESET_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function union(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const set of sets) for (const name of set) out.add(name);
  return out;
}

function difference(base: Set<string>, ...others: Set<string>[]): Set<string> {
  const out = new Set(base);
  for (const other of others) for (const name of other) out.delete(name);
  return out;
}

function intersection(base: Set<string>, other: Set<string>): Set<string> {
  return new Set([...base].filter((name) => other.has(name)));
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function presetFilePath(name: string): string {
  return join(presetsDir(), `${name}.json`);
}

/**
 * preset 名の検証。`_last` は「直前の状態」専用なので、ユーザーからは指定させない。
 *
 * 長さを先に見るのは移行前と同じ順序。65 文字以上は pattern ではなく長さで弾かれる。
 */
export function validatePresetName(name: string, allowLast = false): void {
  if (!allowLast && name === PRESET_LAST_NAME)
    throw new ValueError(`Reserved preset name: ${name}`);
  if (!name || name.length > 64)
    throw new ValueError(`Invalid preset name: ${name}`);
  if (name === PRESET_LAST_NAME) return;
  if (!PRESET_NAME_PATTERN.test(name))
    throw new ValueError(`Invalid preset name: ${name}`);
}

/**
 * preset ファイルを読む。壊れた JSON も `skills` の型崩れも ValueError にする
 * （移行前は `json.JSONDecodeError` が `ValueError` の子なので、どちらも 400）。
 */
export function loadPreset(name: string): PresetData {
  const path = presetFilePath(name);
  if (!exists(path)) throw new NotFoundError(`Preset not found: ${name}`);

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new ValueError(`Invalid preset file: ${name}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ValueError(`Invalid preset file: ${name}`);
  }

  const skills = (data as { skills?: unknown }).skills ?? [];
  if (
    !Array.isArray(skills) ||
    skills.some((skill) => typeof skill !== "string")
  ) {
    throw new ValueError(`Invalid preset skills: ${name}`);
  }
  return { ...(data as PresetData), skills: skills as string[] };
}

/**
 * `_last` は「直前の状態」なので一覧には出さない。
 * 壊れたファイルは黙って飛ばす（移行前も例外を握り潰している）。
 */
export function listUserPresets(): PresetSummary[] {
  const dir = presetsDir();
  if (!exists(dir)) return [];

  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const presets: PresetSummary[] = [];
  for (const entry of files) {
    const stem = entry.slice(0, -".json".length);
    if (stem === PRESET_LAST_NAME) continue;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dir, entry), "utf-8"));
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data))
      continue;
    const record = data as {
      name?: unknown;
      description?: unknown;
      skills?: unknown;
      updatedAt?: unknown;
    };
    presets.push({
      name: String(record.name ?? stem),
      description: String(record.description ?? ""),
      skillCount: Array.isArray(record.skills) ? record.skills.length : 0,
      updatedAt: String(record.updatedAt ?? ""),
    });
  }
  return presets.sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Python の `datetime.now().astimezone().isoformat(timespec="seconds")`。
 * UTC の `Z` ではなくローカルのオフセット付きで書く（保存済みファイルと同じ形）。
 */
export function presetNowIso(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string =>
    String(Math.abs(value)).padStart(width, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";

  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** tmp へ書いてから rename。書き込み中に落ちても preset が壊れて残らない。 */
export function writePresetFile(data: PresetData): void {
  mkdirSync(presetsDir(), { recursive: true });
  const path = presetFilePath(data.name);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * bulk-off の直前に現状を `_last` へ退避する。これが無いと「すべてオフ」から戻せない。
 * 未追跡の skill は Off にすると復元できないので、管理下の active だけを記録する。
 */
export function backupActiveToLast(lock: Lock): void {
  writePresetFile({
    name: PRESET_LAST_NAME,
    skills: sortNames(managedActiveSkills(lock)),
    updatedAt: presetNowIso(),
  });
}

/**
 * 現在の active を preset として保存する。
 *
 * `description` は空なら書かない（移行前と同じで、キーごと省く）。
 */
export function savePresetFromActive(
  name: string,
  lock: Lock,
  description = "",
  overwrite = false
): PresetData {
  validatePresetName(name);
  const active = visibleInstalledNames(lock, activeDir());
  if (active.size === 0)
    throw new ValueError("Cannot save preset: no active skills");
  if (exists(presetFilePath(name)) && !overwrite)
    throw new AlreadyExistsError(`Preset already exists: ${name}`);

  const data: PresetData = {
    name,
    skills: sortNames(active),
    updatedAt: presetNowIso(),
  };
  if (description) data.description = description;
  writePresetFile(data);
  return data;
}

export function deletePreset(name: string): void {
  validatePresetName(name);
  const path = presetFilePath(name);
  if (!exists(path)) throw new NotFoundError(`Preset not found: ${name}`);
  unlinkSync(path);
}

/**
 * preset を当てるための差分。適用はしない。
 *
 * `touchArchive` が false のときは archive を掃除の対象から外す。Restore は
 * 「直前の active に戻す」だけで、その間に archive へ入れたものまで消さない。
 * ここを取り違えると Restore が archive を巻き添えにする。
 */
export function computePresetApplyPlan(
  target: Set<string>,
  lock: Lock,
  touchArchive = true
): PresetPlan {
  const diskActive = installedNames(activeDir());
  const diskArchive = installedNames(archiveDir());
  const visibleActive = visibleInstalledNames(lock, activeDir());
  const visibleArchive = visibleInstalledNames(lock, archiveDir());
  const managed = trackedSkills(lock);
  const unmanaged = ignoredSkills();
  const known = union(
    managed,
    unmanaged,
    visibleActive,
    visibleArchive,
    diskActive,
    diskArchive
  );

  return {
    remove: touchArchive
      ? difference(union(diskActive, diskArchive), target)
      : difference(intersection(diskActive, managed), target),
    restore: difference(intersection(target, diskArchive), diskActive),
    install: difference(target, diskActive, diskArchive, unmanaged),
    unresolved: difference(target, known),
    becomeActive: difference(target, diskActive),
  };
}

export function presetPlanPreview(plan: PresetPlan): PresetPreview["preview"] {
  return {
    active: sortNames(plan.becomeActive),
    off: sortNames(plan.remove),
    install: sortNames(plan.install),
    unresolved: sortNames(plan.unresolved),
  };
}

export function formatPresetApplyPreview(plan: PresetPlan): string {
  const preview = presetPlanPreview(plan);
  const parts: string[] = [];
  if (preview.active.length > 0)
    parts.push(
      `active になる (${preview.active.length}): ${preview.active.join(", ")}`
    );
  if (preview.off.length > 0)
    parts.push(`off になる (${preview.off.length}): ${preview.off.join(", ")}`);
  if (preview.install.length > 0)
    parts.push(
      `install される (${preview.install.length}): ${preview.install.join(", ")}`
    );
  if (preview.unresolved.length > 0) {
    parts.push(
      `unresolved (${preview.unresolved.length}): ${preview.unresolved.join(", ")}`
    );
  }
  return parts.length > 0 ? parts.join("\n") : "変更はありません";
}

export function previewNamedPreset(name: string, lock: Lock): PresetPreview {
  validatePresetName(name);
  const preset = loadPreset(name);
  const skills = preset.skills ?? [];
  if (skills.length === 0)
    throw new ValueError("Cannot apply preset: no skills in preset");

  const plan = computePresetApplyPlan(new Set(skills), lock);
  return {
    name,
    description: String(preset.description ?? ""),
    skills: sortNames(new Set(skills)),
    preview: presetPlanPreview(plan),
    blocked: plan.unresolved.size > 0,
  };
}

export function presetLastExists(): boolean {
  return exists(presetFilePath(PRESET_LAST_NAME));
}

/**
 * Restore の preview。`blocked` は必ず false。
 *
 * 直前の active に、その後 lock から外れた skill が混ざっていることがある。
 * それで Restore 自体を止めてしまうと二度と戻れなくなるので、解決できないものは
 * スキップ扱いにして先へ進める。
 */
export function previewRestorePrevious(lock: Lock): PresetPreview {
  if (!presetLastExists()) throw new ValueError(NO_PREVIOUS_STATE_MESSAGE);
  const last = loadPreset(PRESET_LAST_NAME);
  const skills = new Set(last.skills ?? []);
  const plan = computePresetApplyPlan(skills, lock, false);
  return {
    name: PRESET_LAST_NAME,
    description: "",
    skills: sortNames(skills),
    preview: presetPlanPreview(plan),
    blocked: false,
  };
}

/** `_last` が読めるときだけ Restore を出す。中身が壊れていれば false。 */
export function hasPreviousPreset(): boolean {
  const path = presetFilePath(PRESET_LAST_NAME);
  if (!exists(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data !== "object" || data === null || Array.isArray(data))
      return false;
    const skills = (data as { skills?: unknown }).skills ?? [];
    if (
      !Array.isArray(skills) ||
      skills.some((skill) => typeof skill !== "string")
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
