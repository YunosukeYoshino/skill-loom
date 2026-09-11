/**
 * Web UI Settings モジュールの外部振る舞いを固定する:
 * load/save・旧キー移行・URL view 優先・翻訳フォールバック・壊れた storage の縮退。
 * React をマウントせず、注入した storage だけで検証する。
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  LEGACY_VIEW_MODE_KEY,
  MESSAGES,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  resolveExternalView,
  saveSettings,
  translate,
  type MessageKey,
  type SettingsStorage,
  type UiSettings,
} from "./settings";

function memoryStorage(initial: Record<string, string> = {}): SettingsStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const base: UiSettings = { locale: "en", externalViewMode: "grid" };

describe("loadSettings", () => {
  test("空の storage は English + grid に縮退する", () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  test("壊れた JSON は既定値に縮退する", () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: "{not-json" });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  test("enum として不正な値は既定値に縮退する", () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        locale: "fr",
        externalViewMode: "mosaic",
      }),
    });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  test("部分的な blob は欠けた項目だけ既定値にする", () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ locale: "ja" }),
    });
    expect(loadSettings(storage)).toEqual({
      locale: "ja",
      externalViewMode: "grid",
    });
  });

  test("旧 external-sources-view-mode を移行して削除する", () => {
    const storage = memoryStorage({ [LEGACY_VIEW_MODE_KEY]: "list" });
    const settings = loadSettings(storage);
    expect(settings).toEqual({ locale: "en", externalViewMode: "list" });
    expect(storage.getItem(LEGACY_VIEW_MODE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual(
      settings
    );
  });

  test("blob が有効ならそれを優先しつつ旧キーは削除する", () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        locale: "ja",
        externalViewMode: "grid",
      }),
      [LEGACY_VIEW_MODE_KEY]: "list",
    });
    const settings = loadSettings(storage);
    expect(settings).toEqual({ locale: "ja", externalViewMode: "grid" });
    expect(storage.getItem(LEGACY_VIEW_MODE_KEY)).toBeNull();
  });
});

describe("saveSettings", () => {
  test("loadSettings と往復できる", () => {
    const storage = memoryStorage();
    saveSettings(storage, { locale: "ja", externalViewMode: "list" });
    expect(loadSettings(storage)).toEqual({
      locale: "ja",
      externalViewMode: "list",
    });
  });
});

describe("resolveExternalView", () => {
  test("URL ?view= が設定より優先される", () => {
    expect(resolveExternalView("list", base)).toBe("list");
    expect(
      resolveExternalView("grid", { ...base, externalViewMode: "list" })
    ).toBe("grid");
  });

  test("URL に view が無ければ設定値を使う", () => {
    expect(
      resolveExternalView(undefined, { ...base, externalViewMode: "list" })
    ).toBe("list");
  });

  test("不正な URL view は設定値に縮退する", () => {
    expect(
      resolveExternalView("mosaic", { ...base, externalViewMode: "list" })
    ).toBe("list");
  });
});

describe("translate", () => {
  test("ja ロケールは JA の文字列を返す", () => {
    expect(translate("ja", "common.cancel")).toBe("キャンセル");
  });

  test("ja に無いキーは en にフォールバックする", () => {
    const catalogs = {
      en: { "common.cancel": "Cancel" },
      ja: {},
    };
    expect(translate("ja", "common.cancel", undefined, catalogs)).toBe(
      "Cancel"
    );
  });

  test("どのカタログにも無いキーはキー文字列を返す", () => {
    const catalogs = { en: {}, ja: {} };
    expect(translate("en", "common.cancel", undefined, catalogs)).toBe(
      "common.cancel"
    );
  });

  test("{param} を補間する", () => {
    expect(translate("en", "preset.deleteConfirm", { name: "dev" })).toBe(
      "Delete preset “dev”?"
    );
  });

  test("ja カタログは en の全キーを網羅する", () => {
    for (const key of Object.keys(MESSAGES.en) as MessageKey[]) {
      expect(MESSAGES.ja[key]).toBeDefined();
    }
  });
});
