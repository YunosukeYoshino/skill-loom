/**
 * Web UI Settings — locale と External 表示既定をまとめて持つブラウザローカルな設定。
 * 永続化は単一 localStorage キー (`skill-loom.settings`) の JSON blob。
 * 旧 `external-sources-view-mode` は最初の読み込み時に blob へ移行して削除する。
 * storage は注入可能で、このモジュールは React なしで単体テストできる。
 */

export type UiLocale = "en" | "ja";
export type ExternalViewMode = "grid" | "list";
export type UiSettings = {
  locale: UiLocale;
  externalViewMode: ExternalViewMode;
};

export const SETTINGS_STORAGE_KEY = "skill-loom.settings";
export const LEGACY_VIEW_MODE_KEY = "external-sources-view-mode";

export const DEFAULT_SETTINGS: UiSettings = {
  locale: "en",
  externalViewMode: "grid",
};

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const toLocale = (v: unknown): UiLocale | undefined =>
  v === "en" || v === "ja" ? v : undefined;
const toViewMode = (v: unknown): ExternalViewMode | undefined =>
  v === "grid" || v === "list" ? v : undefined;

function readItem(storage: SettingsStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function loadSettings(storage: SettingsStorage): UiSettings {
  let parsed: Record<string, unknown> = {};
  const raw = readItem(storage, SETTINGS_STORAGE_KEY);
  if (raw) {
    try {
      const json: unknown = JSON.parse(raw);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      /* 壊れた blob は無視して既定値へ */
    }
  }

  const legacy = readItem(storage, LEGACY_VIEW_MODE_KEY);

  const settings: UiSettings = {
    locale: toLocale(parsed.locale) ?? DEFAULT_SETTINGS.locale,
    externalViewMode:
      toViewMode(parsed.externalViewMode) ??
      toViewMode(legacy) ??
      DEFAULT_SETTINGS.externalViewMode,
  };

  // 旧キーが残っていれば新 blob を書き戻してから削除し、二重管理を残さない。
  // 書き込めない環境では旧キーを残し、次回読み込み時に移行をやり直す。
  if (legacy !== null) {
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      storage.removeItem(LEGACY_VIEW_MODE_KEY);
    } catch {
      /* ignore */
    }
  }
  return settings;
}

export function saveSettings(
  storage: SettingsStorage,
  settings: UiSettings
): void {
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/**
 * External Sources の実効 view — URL ?view= があればそれが勝ち、
 * なければ Settings の既定値を使う。
 */
export function resolveExternalView(
  urlView: string | undefined,
  settings: UiSettings
): ExternalViewMode {
  return toViewMode(urlView) ?? settings.externalViewMode;
}

/* ======================================================================
 * メッセージカタログ — 依存を増やさない型付きマップ。
 * en が正本で全キーを持ち、ja は欠けたキーを en にフォールバックする。
 * ドメイン用語 (Catalog / Projection / Deck / global / tristate …) は
 * CONTEXT.md の語彙を保つため両ロケールで同じ表記を維持する。
 * ====================================================================== */

const en = {
  // nav / chrome
  "nav.aria": "Sections",
  "nav.global": "Global",
  "nav.external": "External",
  "nav.drafts": "Drafts",
  "nav.decks": "Decks",
  "nav.newDeck": "+ Deck",
  "nav.settings": "Settings",
  "search.aria": "Search skills",
  "search.placeholder": "Search skills…",
  "filter.placeholder": "Filter skills…",
  "common.skipToContent": "Skip to content",
  "common.loading": "Loading…",
  "common.processing": "Working…",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.apply": "Apply",
  "common.create": "Create",
  "common.creating": "Creating…",
  "common.run": "Run",
  "common.selectAll": "Select all",
  "common.clearAll": "Clear all",
  "common.checking": "Checking…",
  "common.updating": "Updating…",
  "common.noMatches": "No matching skills",
  "projection.caption": "Runtime subset woven from Catalog {total}.",

  // error chrome
  "error.title": "Failed to load",
  "error.hint":
    "Open another screen from the nav, or reload the page. In development, make sure you opened the public URL printed at startup (Skill Loom UI), not the Vite internal port.",
  "error.routeTitle": "Something went wrong",
  "error.fallback": "An unexpected error occurred.",
  "error.notFound": "Not found",
  "error.notFoundMessage": "The requested page was not found.",

  // deck create form
  "deckForm.label": "New deck name",
  "deckForm.placeholder": "e.g. frontend deck name…",

  // sort headers / status toggle
  "sort.name": "Name",
  "sort.category": "Category",
  "sort.source": "Source",
  "sort.status": "Status",
  "statusToggle.aria": "{name} status",

  // tristate / checkbox lists
  "tristate.apply": "Apply",
  "tristate.applying": "Applying…",
  "tristate.bulkOff": "Turn all off",
  "tristate.bulkOffConfirm":
    "Turn off all active skills managed by this repository (unmanaged skills stay as they are). You can restore the previous configuration with “Restore previous”. Continue?",
  "tristate.archived": "Archived skills ({count})",
  "list.collisionBadge": "namespaced",

  // external import form
  "import.aria": "Source for external skills",
  "import.placeholder": "owner/repo or GitHub URL…",
  "import.fetch": "Fetch candidates",
  "import.fetching": "Fetching…",

  // view toggle
  "view.aria": "View mode",
  "view.grid": "Grid",
  "view.list": "List",

  // custom updates panel
  "custom.newerSource": "Newer source ({count})",
  "custom.newerSourceBadge": "Newer source",
  "custom.updateAll": "Update all with updates ({count})",
  "custom.updateOne": "Update",
  "custom.diffNote": "SKILL.md matches. Other files have changes.",

  // presets panel
  "preset.title": "Presets",
  "preset.selectAria": "Select a preset",
  "preset.none": "No saved presets",
  "preset.overwrite": "Overwrite",
  "preset.saveAs": "Save as new…",
  "preset.restoreLast": "Restore previous",
  "preset.deleteConfirm": "Delete preset “{name}”?",
  "preset.newName": "New preset name",
  "preset.newPlaceholder": "e.g. dev-and-writing…",
  "preset.applyNamed": "Apply preset “{name}”",
  "preset.applyLast": "Apply last active configuration",
  "preset.becomeActive": "become active",
  "preset.becomeOff": "become off",
  "preset.willInstall": "will be installed",
  "preset.restoreSkip": "restore skipped",
  "preset.unresolved": "unresolved",
  "preset.noChanges": "No changes",

  // busy status lines (ActionStatus)
  "status.checkSource": "Checking for source updates…",
  "status.updatingSkills": "Updating skills…",
  "status.bulkOff": "Turning off all active skills…",
  "status.applying": "Applying changes…",
  "status.fetchCandidates": "Fetching external skill candidates…",
  "status.preset": "Running preset operation…",
  "status.addingSelected": "Adding selected skills…",
  "status.checkSources": "Checking external sources for updates…",
  "status.updateSources": "Updating all skills with updates…",
  "status.updateSource": "Updating this source…",
  "status.updateSkill": "Updating skill…",
  "status.removing": "Removing from management…",
  "status.installing": "Installing skill…",
  "status.applyingGlobal": "Applying global on/off…",
  "status.draftOp": "Running draft operation…",
  "status.deckApply": "Applying deck changes…",

  // global page
  "global.catalogOverline": "Catalog · candidates",
  "global.projectionOverline": "Projection · tristate",
  "global.catalogSub": "Add external skills",
  "global.backToGlobal": "Back to global",
  "global.addSkills": "Add skills",
  "global.checkUpdates": "Check for updates",

  // external preview page
  "preview.title": "External skills",
  "preview.noSource": "No source specified",
  "preview.overline": "Catalog · external preview",
  "preview.backToCatalog": "Back to catalog",
  "preview.addDeckOnly": "Add to deck only",
  "preview.installAdd": "Install and add",
  "preview.installGlobal": "Install and add to global",

  // external sources page
  "sources.overline": "Catalog · external sources",
  "sources.checkAll": "Check all for updates",
  "sources.updateAll": "Update all with updates ({count})",
  "sources.empty":
    "No external sources yet. Add an owner/repo from “Add skills”.",

  // external source detail page
  "detail.back": "Back to sources",
  "detail.updateAll": "Update all in this source ({count})",
  "detail.allGlobalOn": "All global on",
  "detail.hasUpdate": "Update available",
  "detail.updateOne": "Update",
  "detail.removeConfirm":
    "Remove from management? Applies to global remove, skills.lock.json, and project-decks.",
  "detail.remove": "Remove from management",
  "detail.available": "Available to install",
  "detail.installSelected": "Install selected",

  // drafts page
  "drafts.overline": "Catalog · drafts",
  "drafts.help":
    "Promoting a draft performs official placement and lock registration. Adding to global also applies to ~/.agents/skills.",
  "drafts.confirmOverwrite":
    "The selected drafts are already registered or their destination already exists. Continue only if you want to overwrite.",
  "drafts.promoteForce": "Overwrite and promote",
  "drafts.installForce": "Overwrite and add to global",
  "drafts.promote": "Promote draft",
  "drafts.install": "Promote and add to global",

  // project deck page
  "deck.copy": "copy",
  "deck.copied": "copied",
  "deck.showOnly": "Show deck only",
  "deck.save": "Save deck",
  "deck.apply": "Apply this deck",
  "deck.addGlobal": "Add to global",

  // settings page
  "settings.title": "Settings",
  "settings.overline": "Web UI · settings",
  "settings.sub": "UI preferences saved in this browser",
  "settings.language": "Language",
  "settings.languageHelp": "Language for Web UI text. Applies immediately.",
  "settings.viewDefault": "External default view",
  "settings.viewHelp": "Used when the URL has no view parameter.",
} as const;

export type MessageKey = keyof typeof en;

export type MessageCatalog = Partial<Record<MessageKey, string>>;

const ja: MessageCatalog = {
  "nav.aria": "セクション",
  "nav.global": "Global",
  "nav.external": "External",
  "nav.drafts": "Drafts",
  "nav.decks": "Decks",
  "nav.newDeck": "+ Deck",
  "nav.settings": "設定",
  "search.aria": "スキルを検索",
  "search.placeholder": "スキルを検索…",
  "filter.placeholder": "スキルを絞り込む…",
  "common.skipToContent": "本文へスキップ",
  "common.loading": "読み込み中…",
  "common.processing": "処理中…",
  "common.cancel": "キャンセル",
  "common.save": "保存",
  "common.delete": "削除",
  "common.apply": "適用",
  "common.create": "作成",
  "common.creating": "作成中…",
  "common.run": "実行",
  "common.selectAll": "すべて選択",
  "common.clearAll": "すべて解除",
  "common.checking": "確認中…",
  "common.updating": "更新中…",
  "common.noMatches": "一致するスキルがありません",
  "projection.caption": "Catalog {total} から織り込まれた実行中の subset",

  "error.title": "読み込みに失敗しました",
  "error.hint":
    "ナビから別の画面へ移動するか、ページを再読み込みしてください。開発時は Vite の内部ポートではなく、起動ログの公開 URL（Skill Loom UI）を開いているか確認してください。",
  "error.routeTitle": "問題が発生しました",
  "error.fallback": "予期しないエラーが発生しました。",
  "error.notFound": "ページが見つかりません",
  "error.notFoundMessage": "指定されたページが見つかりませんでした。",

  "deckForm.label": "新しい Deck 名",
  "deckForm.placeholder": "例: frontend などの deck 名…",

  "sort.name": "名前",
  "sort.category": "カテゴリ",
  "sort.source": "ソース",
  "sort.status": "状態",
  "statusToggle.aria": "{name} の状態",

  "tristate.apply": "反映",
  "tristate.applying": "反映中…",
  "tristate.bulkOff": "すべてオフ",
  "tristate.bulkOffConfirm":
    "このリポジトリ管理下のアクティブなスキルをすべてオフにします（未管理のスキルはそのまま）。直前の構成は「直前に戻す」で復元できます。よろしいですか？",
  "tristate.archived": "Archived skills ({count})",
  "list.collisionBadge": "衝突回避",

  "import.aria": "外部skillsの追加元",
  "import.placeholder": "owner/repo または GitHub URL…",
  "import.fetch": "候補を取得",
  "import.fetching": "取得中…",

  "view.aria": "表示モード",
  "view.grid": "グリッド",
  "view.list": "リスト",

  "custom.newerSource": "正本が新しい ({count})",
  "custom.newerSourceBadge": "正本が新しい",
  "custom.updateAll": "更新があるものをすべてupdate ({count})",
  "custom.updateOne": "個別update",
  "custom.diffNote": "SKILL.md は一致。他ファイルに差分があります。",

  "preset.title": "プリセット",
  "preset.selectAria": "プリセットを選択",
  "preset.none": "保存済みプリセットなし",
  "preset.overwrite": "上書き保存",
  "preset.saveAs": "別名で保存…",
  "preset.restoreLast": "直前に戻す",
  "preset.deleteConfirm": "プリセット “{name}” を削除しますか？",
  "preset.newName": "新しいプリセット名",
  "preset.newPlaceholder": "例: 開発・執筆 などの名前…",
  "preset.applyNamed": "プリセット “{name}” を適用",
  "preset.applyLast": "直前の active 構成を適用",
  "preset.becomeActive": "active になる",
  "preset.becomeOff": "off になる",
  "preset.willInstall": "install される",
  "preset.restoreSkip": "復元スキップ",
  "preset.unresolved": "unresolved",
  "preset.noChanges": "変更はありません",

  "status.checkSource": "正本の更新を確認しています…",
  "status.updatingSkills": "スキルを更新しています…",
  "status.bulkOff": "アクティブなスキルをすべてオフにしています…",
  "status.applying": "変更を反映しています…",
  "status.fetchCandidates": "外部スキルの候補を取得しています…",
  "status.preset": "プリセット操作を実行しています…",
  "status.addingSelected": "選択したスキルを追加しています…",
  "status.checkSources": "外部ソースの更新を確認しています…",
  "status.updateSources": "更新があるスキルを一括更新しています…",
  "status.updateSource": "このソースを一括更新しています…",
  "status.updateSkill": "スキルを更新しています…",
  "status.removing": "管理から外しています…",
  "status.installing": "スキルをインストールしています…",
  "status.applyingGlobal": "global のオン/オフを反映しています…",
  "status.draftOp": "draft操作を実行しています…",
  "status.deckApply": "deckの変更を反映しています…",

  "global.catalogOverline": "Catalog · 追加候補",
  "global.projectionOverline": "Projection · tristate",
  "global.catalogSub": "外部スキルの追加",
  "global.backToGlobal": "globalに戻る",
  "global.addSkills": "skillsを追加",
  "global.checkUpdates": "更新を確認",

  "preview.title": "外部スキル",
  "preview.noSource": "source がありません",
  "preview.overline": "Catalog · 外部プレビュー",
  "preview.backToCatalog": "catalogに戻る",
  "preview.addDeckOnly": "deckにだけ追加",
  "preview.installAdd": "installして追加",
  "preview.installGlobal": "installしてglobalに追加",

  "sources.overline": "Catalog · external sources",
  "sources.checkAll": "すべて更新を確認",
  "sources.updateAll": "更新があるものをすべてupdate ({count})",
  "sources.empty":
    "外部ソースがありません。「skillsを追加」から owner/repo を追加できます。",

  "detail.back": "sourcesに戻る",
  "detail.updateAll": "このsourceをすべてupdate ({count})",
  "detail.allGlobalOn": "すべて global オン",
  "detail.hasUpdate": "更新あり",
  "detail.updateOne": "個別update",
  "detail.removeConfirm":
    "管理から外しますか？ global remove、skills.lock.json、project-decks に反映します。",
  "detail.remove": "管理から外す",
  "detail.available": "install 可能",
  "detail.installSelected": "選択してinstall",

  "drafts.overline": "Catalog · drafts",
  "drafts.help":
    "draft解除で正式配置とlock登録を行います。global追加は ~/.agents/skills にも反映します。",
  "drafts.confirmOverwrite":
    "選択したdraftは既に正式登録済み、または正式配置先が存在します。上書きする場合だけ続行してください。",
  "drafts.promoteForce": "上書きしてdraft解除",
  "drafts.installForce": "上書きしてglobalに追加",
  "drafts.promote": "draft解除",
  "drafts.install": "draft解除してglobalに追加",

  "deck.copy": "copy",
  "deck.copied": "コピーしました",
  "deck.showOnly": "deckだけ表示",
  "deck.save": "deckを保存",
  "deck.apply": "このdeckを適用",
  "deck.addGlobal": "globalに追加",

  "settings.title": "設定",
  "settings.overline": "Web UI · 設定",
  "settings.sub": "このブラウザに保存する UI 設定",
  "settings.language": "言語",
  "settings.languageHelp": "Web UI の表示言語。すぐに反映されます。",
  "settings.viewDefault": "External のデフォルト表示",
  "settings.viewHelp": "URL に view 指定がないときに使われます。",
};

export const MESSAGES: Record<UiLocale, MessageCatalog> = { en, ja };

export type MessageParams = Record<string, string | number>;

function isDev(): boolean {
  const viteDev = import.meta.env?.DEV;
  if (typeof viteDev === "boolean") return viteDev;
  return (
    typeof process === "undefined" || process.env?.NODE_ENV !== "production"
  );
}

/**
 * アクティブ locale で key を解決する。ja に無いキーは en にフォールバックし、
 * en にも無ければキー文字列を返す。欠けているキーは開発時に console.warn する。
 */
export function translate(
  locale: UiLocale,
  key: MessageKey,
  params?: MessageParams,
  catalogs: Record<UiLocale, MessageCatalog> = MESSAGES
): string {
  const localized = catalogs[locale]?.[key];
  if (isDev() && localized === undefined) {
    console.warn(
      `[skill-loom] missing translation: locale="${locale}" key="${key}"`
    );
  }
  const template = localized ?? catalogs.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}
