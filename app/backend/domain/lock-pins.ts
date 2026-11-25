/**
 * `skills.lock.pins.json` の読み書き。Catalog 側の `scripts/lock_pins.py` が `check` で
 * 読むので、書式（section 内のキー昇順、indent 2、非 ASCII をそのまま、末尾改行）と
 * 1 件の形（sourceUrl・commit・ref・resolvedAt）をそちらに揃える。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lockPinsFile } from "./config";

export type LockPin = {
  sourceUrl?: string;
  commit: string;
  ref?: string;
  resolvedAt?: string;
};

type PinSection = Record<string, LockPin>;

export type LockPins = {
  external: PinSection;
  vendor: PinSection;
};

function asSection(value: unknown): PinSection {
  return typeof value === "object" && value !== null
    ? (value as PinSection)
    : {};
}

/** ファイルが無い Catalog は pins を使っていない。null を返し、呼び出し側は書かない。 */
export function loadLockPins(): LockPins | null {
  const path = lockPinsFile();
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    unknown
  >;
  return { external: asSection(data.external), vendor: asSection(data.vendor) };
}

function sortedSection(section: PinSection): PinSection {
  return Object.fromEntries(
    Object.keys(section)
      .sort()
      .map((name) => [name, section[name] as LockPin])
  );
}

/** `lock_pins.py` の resolvedAt と同じ秒精度の UTC。 */
export function pinTimestamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function pinEntry(
  sourceUrl: string | undefined,
  commit: string,
  resolvedAt: string
): LockPin {
  return {
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    commit,
    ref: "HEAD",
    resolvedAt,
  };
}

/** external の指定分だけ差し替えて書き戻す。読んでから書くまでに他が足した pin は落とさない。 */
export function advanceExternalPins(updates: Record<string, LockPin>): void {
  const current = loadLockPins();
  if (!current) return;
  const path = lockPinsFile();
  const next = {
    external: sortedSection({ ...current.external, ...updates }),
    vendor: sortedSection(current.vendor),
  };
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, path);
}
