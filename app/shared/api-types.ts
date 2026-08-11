/**
 * API レスポンス型の単一の source of truth。
 *
 * サーバ（`server/`）とフロントエンド（`frontend/src/`）の双方がここを import する。
 * 片方だけを変えられないようにするための配置なので、フロント側にコピーを作らない。
 */

export type Tristate = "off" | "active" | "archive"

export type SkillRow = {
  name: string
  category: string
  description: string
  source: string
  state: string
  checked?: boolean
  selection?: Tristate
  can_activate?: boolean
}

export type Counts = {
  active: number
  off: number
  archive: number
  total: number
}

export type CustomUpdatable = {
  name: string
  state: string
  repoPath: string
  skillDiff: string
  otherChangedFiles: string[]
}

export type GlobalPayload = {
  page: string
  title: string
  message: string
  decks: string[]
  showCatalog: boolean
  rows: SkillRow[]
  archivedRows: SkillRow[]
  counts: Counts | null
  customUpdatesChecked?: boolean
  customUpdatable?: CustomUpdatable[]
  presets?: PresetSummary[]
  hasPreviousPreset?: boolean
  hasManagedActive?: boolean
  presetPreview?: PresetPreview
}

export type PresetSummary = {
  name: string
  description: string
  skillCount: number
  updatedAt: string
}

export type PresetPreview = {
  name: string
  description: string
  skills: string[]
  preview: {
    active: string[]
    off: string[]
    install: string[]
    unresolved: string[]
  }
  blocked: boolean
}

export type ExternalSource = {
  source: string
  owner: string
  repo: string
  sourceUrl: string
  skills: string[]
  statusLabel: string
  updatable: string[]
  checked: boolean
  /** 未確認・確認成功はどちらも null。移行前が `None` を出していたので undefined にはしない。 */
  error: string | null
}

export type OgpPayload = {
  source: string
  title: string | null
  description: string | null
  image: string | null
}

export type ExternalSourcesPayload = {
  page: string
  title: string
  message: string
  decks: string[]
  sources: ExternalSource[]
  totalUpdatable: number
  updateStatusBySource: Record<string, { checked?: boolean; updatable?: string[]; error?: string }>
}

export type InstalledExternal = {
  name: string
  description: string
  path: string
  /** Global projection: active | off | archive */
  state: Tristate
  hasUpdate: boolean
  updateCommand: string
  managed: boolean
}

export type ExternalSourceDetailPayload = {
  page: string
  title: string
  message: string
  decks: string[]
  source: string
  installed: InstalledExternal[]
  available: SkillRow[]
  updatable: string[]
}

export type DraftsPayload = {
  page: string
  title: string
  message: string
  decks: string[]
  rows: SkillRow[]
  confirmSelected: string[]
}

export type ProjectDeckPayload = {
  page: string
  title: string
  message: string
  decks: string[]
  deckName: string
  showCatalog: boolean
  rows: SkillRow[]
  installCommands: string[]
  skillNames: string[]
}

export type ExternalPreviewPayload = {
  page: string
  title: string
  message: string
  decks: string[]
  deckName: string
  source: string
  rows: SkillRow[]
}

export type ApiErrorBody = {
  message?: string
}
