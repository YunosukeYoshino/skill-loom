import { useEffect, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ApiError, api } from "@/api/client"
import type {
  CustomUpdatable,
  ExternalSourceDetailPayload,
  InstalledExternal,
  PresetPreview,
  PresetSummary,
  SkillRow,
  Tristate,
} from "@shared/api-types"
import { CheckboxList, ExternalImportForm, SearchField, TristateList } from "@/components/lists"
import { ActionStatus, BusyRegion, Button, Masthead, Message, Nav, PageError, PageLoading, Shell, pendingLabel } from "@/components/ui"

function errMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined
}

function useOgp(source: string) {
  return useQuery({
    queryKey: ["ogp", source],
    queryFn: () => api.ogp(source),
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
}

type ViewMode = "grid" | "list"

const VIEW_MODE_STORAGE_KEY = "external-sources-view-mode"

function readViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    if (stored === "grid" || stored === "list") return stored
  } catch {
    /* ignore */
  }
  return "grid"
}

function ViewModeToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  const item = (mode: ViewMode, label: string, icon: ReactNode) => {
    const active = value === mode
    return (
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        title={label}
        onClick={() => onChange(mode)}
        className={
          active
            ? "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-ink)] shadow-[var(--shadow-lift)] transition-[transform,background,color] duration-100 ease-out active:scale-[0.97]"
            : "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-2)] transition-[transform,background,color] duration-100 ease-out hover:bg-[var(--surface)] hover:text-[var(--color-ink)] active:scale-[0.97]"
        }
      >
        {icon}
        <span>{label}</span>
      </button>
    )
  }

  return (
    <div
      className="ml-auto flex rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-0.5"
      role="group"
      aria-label="表示モード"
    >
      {item(
        "grid",
        "グリッド",
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="8.5" y="1" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="8.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="8.5" y="8.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>,
      )}
      {item(
        "list",
        "リスト",
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="2" width="12" height="2.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="6.75" width="12" height="2.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="11.5" width="12" height="2.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>,
      )}
    </div>
  )
}

function OgpPreview({ source, variant = "list" }: { source: string; variant?: ViewMode }) {
  const q = useOgp(source)

  if (variant === "list") {
    if (!q.data?.image) return null
    return (
      <img
        src={q.data.image}
        alt=""
        loading="lazy"
        className="h-16 w-28 flex-none rounded-[var(--radius-sm)] border border-[var(--color-rule)] object-cover"
        onError={(e) => {
          e.currentTarget.style.display = "none"
        }}
      />
    )
  }

  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-[var(--color-paper-2)] to-[var(--color-paper-3)]">
      {q.data?.image ? (
        <img
          src={q.data.image}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none"
          }}
        />
      ) : null}
    </div>
  )
}

function ExternalSourceMeta({
  src,
}: {
  src: { source: string; owner: string; repo: string; skills: { length: number }; statusLabel: string }
}) {
  return (
    <>
      <h2 className="m-0 mb-1.5 text-base font-semibold text-[var(--color-ink)]">{src.source}</h2>
      <div className="flex flex-wrap gap-3 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
        <span>author {src.owner}</span>
        <span>repo {src.repo}</span>
        <span>skills {src.skills.length}</span>
        {src.statusLabel ? <span>{src.statusLabel}</span> : null}
      </div>
    </>
  )
}

function OgpBanner({ source }: { source: string }) {
  const q = useOgp(source)
  if (!q.data || (!q.data.image && !q.data.description)) return null
  return (
    <div className="mb-3 flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
      {q.data.image ? (
        <img
          src={q.data.image}
          alt=""
          loading="lazy"
          className="h-20 w-36 flex-none rounded-[var(--radius-sm)] border border-[var(--color-rule)] object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none"
          }}
        />
      ) : null}
      <div className="min-w-0">
        <p className="m-0 mb-1 text-sm font-semibold text-[var(--color-ink)]">{q.data.title || source}</p>
        {q.data.description ? <p className="m-0 text-xs text-[var(--color-ink-2)]">{q.data.description}</p> : null}
      </div>
    </div>
  )
}

function applyErrorBody<T>(err: unknown, set: (body: T) => void) {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as T & { page?: unknown; decks?: unknown }
    // FastAPI 既定の {detail} など不完全なエラー体でキャッシュを壊さない
    if (body.page == null && !Array.isArray(body.decks)) return
    set(err.body as T)
  }
}

function CustomUpdatesPanel({
  items,
  busy,
  onUpdateOne,
  onUpdateAll,
}: {
  items: CustomUpdatable[]
  busy?: boolean
  onUpdateOne: (name: string) => void
  onUpdateAll: () => void
}) {
  if (!items.length) return null
  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold">正本が新しい ({items.length})</h2>
        <Button variant="primary" disabled={busy} onClick={onUpdateAll}>
          {pendingLabel(!!busy, `更新があるものをすべてupdate (${items.length})`, "更新中…")}
        </Button>
      </div>
      <div className="grid gap-3">
        {items.map((item) => (
          <details key={item.name} className="rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-3">
            <summary className="cursor-pointer list-none">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-[family-name:var(--font-mono)] text-sm font-medium">{item.name}</code>
                <span className="rounded px-1.5 py-0.5 text-[11px] bg-[var(--color-warn-soft)] text-[var(--color-warn)]">
                  正本が新しい
                </span>
                <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
                  {item.state} · {item.repoPath}
                </span>
                <Button
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault()
                    onUpdateOne(item.name)
                  }}
                >
                  {pendingLabel(!!busy, "個別update", "更新中…")}
                </Button>
              </div>
            </summary>
            <div className="mt-3 space-y-2">
              {item.skillDiff ? (
                <pre className="max-h-72 overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] p-2 text-xs leading-relaxed">
                  {item.skillDiff}
                </pre>
              ) : (
                <p className="m-0 text-xs text-[var(--color-ink-2)]">SKILL.md は一致。他ファイルに差分があります。</p>
              )}
              {item.otherChangedFiles.length ? (
                <p className="m-0 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
                  other: {item.otherChangedFiles.join(", ")}
                </p>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

function PresetPreviewPanel({ preview }: { preview: PresetPreview }) {
  const delta = preview.preview || { active: [], off: [], install: [], unresolved: [] }
  const rows = [
    { label: "active になる", items: delta.active || [] },
    { label: "off になる", items: delta.off || [] },
    { label: "install される", items: delta.install || [] },
    {
      label: preview.name === "_last" ? "復元スキップ" : "unresolved",
      items: delta.unresolved || [],
    },
  ].filter((row) => row.items.length > 0)

  if (!rows.length) {
    return <p className="m-0 text-sm text-[var(--color-ink-2)]">変更はありません</p>
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => (
        <div key={row.label}>
          <p className="m-0 mb-1 text-xs font-semibold text-[var(--color-ink-2)]">
            {row.label} ({row.items.length})
          </p>
          <p className="m-0 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink)]">
            {row.items.join(", ")}
          </p>
        </div>
      ))}
    </div>
  )
}

function PresetsPanel({
  presets,
  hasPrevious,
  busy,
  preview,
  onApplyRequest,
  onApplyConfirm,
  onRestoreRequest,
  onRestoreConfirm,
  onOverwriteSave,
  onSaveAsNew,
  onDelete,
  onCancelPreview,
}: {
  presets: PresetSummary[]
  hasPrevious: boolean
  busy?: boolean
  preview: PresetPreview | null
  onApplyRequest: (name: string) => void
  onApplyConfirm: () => void
  onRestoreRequest: () => void
  onRestoreConfirm: () => void
  onOverwriteSave: (name: string) => void
  onSaveAsNew: (name: string) => void
  onDelete: (name: string) => void
  onCancelPreview: () => void
}) {
  const [selected, setSelected] = useState(presets[0]?.name || "")
  const [newPresetName, setNewPresetName] = useState("")

  useEffect(() => {
    if (presets.length && !presets.some((preset) => preset.name === selected)) {
      setSelected(presets[0]?.name || "")
    }
  }, [presets, selected])

  const saveAsNew = () => {
    const name = newPresetName.trim()
    if (!name) return
    onSaveAsNew(name)
    setNewPresetName("")
    setSelected(name)
  }

  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold">プリセット</h2>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy || !presets.length || !!preview}
          className="min-w-[180px] rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-2.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          {presets.length ? (
            presets.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name} ({preset.skillCount})
              </option>
            ))
          ) : (
            <option value="">保存済みプリセットなし</option>
          )}
        </select>
        <Button disabled={busy || !selected || !!preview} onClick={() => onApplyRequest(selected)}>
          {pendingLabel(!!busy, "適用", "処理中…")}
        </Button>
        <Button disabled={busy || !selected || !!preview} onClick={() => onOverwriteSave(selected)}>
          {pendingLabel(!!busy, "上書き保存", "処理中…")}
        </Button>
        <Button
          disabled={busy || !selected || !!preview}
          onClick={() => {
            if (confirm(`プリセット "${selected}" を削除しますか？`)) onDelete(selected)
          }}
        >
          {pendingLabel(!!busy, "削除", "処理中…")}
        </Button>
        <Button disabled={busy || !hasPrevious || !!preview} onClick={onRestoreRequest}>
          {pendingLabel(!!busy, "直前に戻す", "処理中…")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-rule)] pt-3">
        <label htmlFor="new-preset-name" className="text-sm text-[var(--color-ink-2)]">
          別名で保存
        </label>
        <input
          id="new-preset-name"
          type="text"
          value={newPresetName}
          onChange={(e) => setNewPresetName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveAsNew()
          }}
          disabled={busy || !!preview}
          placeholder="新しいプリセット名"
          autoComplete="off"
          spellCheck={false}
          className="min-w-[200px] flex-1 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 py-2 font-[family-name:var(--font-mono)] text-sm outline-none transition-[border-color,box-shadow] duration-100 focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button disabled={busy || !newPresetName.trim() || !!preview} onClick={saveAsNew}>
          {pendingLabel(!!busy, "保存", "処理中…")}
        </Button>
      </div>
      {preview ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-3">
          <p className="m-0 mb-2 text-sm font-semibold">
            {preview.name === "_last" ? "直前の active 構成" : `プリセット "${preview.name}"`} を適用
          </p>
          <PresetPreviewPanel preview={preview} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || preview.blocked} onClick={preview.name === "_last" ? onRestoreConfirm : onApplyConfirm}>
              {pendingLabel(!!busy, "実行", "処理中…")}
            </Button>
            <Button disabled={busy} onClick={onCancelPreview}>
              キャンセル
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function GlobalPage({ catalog }: { catalog: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ["global", catalog], queryFn: () => api.global(catalog) })
  const [presetPreview, setPresetPreview] = useState<PresetPreview | null>(null)
  const [pendingPresetName, setPendingPresetName] = useState("")

  const apply = useMutation({
    mutationFn: (states: Record<string, Tristate>) => api.apply(states),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", catalog], body)),
  })

  const bulkOff = useMutation({
    mutationFn: () => api.bulkOff(),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const checkCustom = useMutation({
    mutationFn: () => api.checkCustomUpdates(),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const updateCustomOne = useMutation({
    mutationFn: (skill: string) => api.updateCustomSkill(skill),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const updateCustomAll = useMutation({
    mutationFn: () => api.updateAllCustomSkills(),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const externalPreview = useMutation({
    mutationFn: (source: string) => api.previewExternal(source, ""),
    onSuccess: (data) => {
      qc.setQueryData(["external-preview", "", data.source], data)
      navigate({ to: "/external-preview", search: { source: data.source, deck: "" } })
    },
  })

  const presetApplyPreview = useMutation({
    mutationFn: (name: string) => api.applyPreset(name, false),
    onSuccess: (data) => {
      if (data.presetPreview) {
        setPresetPreview(data.presetPreview)
        setPendingPresetName(data.presetPreview.name)
      }
    },
    onError: (err) => applyErrorBody(err, (body) => {
      qc.setQueryData(["global", false], body)
      if (body && typeof body === "object" && "presetPreview" in body) {
        setPresetPreview((body as { presetPreview?: PresetPreview }).presetPreview || null)
      }
    }),
  })

  const presetApplyConfirm = useMutation({
    mutationFn: (name: string) => api.applyPreset(name, true),
    onSuccess: (data) => {
      setPresetPreview(null)
      setPendingPresetName("")
      qc.setQueryData(["global", false], data)
    },
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const presetRestorePreview = useMutation({
    mutationFn: () => api.restorePreset(false),
    onSuccess: (data) => {
      if (data.presetPreview) {
        setPresetPreview({ ...data.presetPreview, name: "_last" })
      }
    },
    onError: (err) => applyErrorBody(err, (body) => {
      qc.setQueryData(["global", false], body)
      if (body && typeof body === "object" && "presetPreview" in body) {
        setPresetPreview({ ...(body as { presetPreview: PresetPreview }).presetPreview, name: "_last" })
      }
    }),
  })

  const presetRestoreConfirm = useMutation({
    mutationFn: () => api.restorePreset(true),
    onSuccess: (data) => {
      setPresetPreview(null)
      qc.setQueryData(["global", false], data)
    },
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const presetSave = useMutation({
    mutationFn: ({ name, overwrite }: { name: string; overwrite: boolean }) => api.savePreset(name, overwrite),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  const presetDelete = useMutation({
    mutationFn: (name: string) => api.deletePreset(name),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["global", false], body)),
  })

  if (q.isPending) return <PageLoading variant="list" withCounts />
  if (q.isError) {
    return <PageError current="global" message={(q.error as Error).message} />
  }
  const data = q.data
  const customCheckBusy = checkCustom.isPending
  const customUpdateBusy = updateCustomOne.isPending || updateCustomAll.isPending
  const customBusy = customCheckBusy || customUpdateBusy
  const presetBusy =
    presetApplyPreview.isPending ||
    presetApplyConfirm.isPending ||
    presetRestorePreview.isPending ||
    presetRestoreConfirm.isPending ||
    presetSave.isPending ||
    presetDelete.isPending
  const listBusy = apply.isPending || bulkOff.isPending || presetBusy

  return (
    <Shell>
      <Masthead title={data.title} counts={data.counts} />
      <Nav current="global" decks={data.decks || []} />
      <Message
        text={
          data.message ||
          errMessage(apply.error) ||
          errMessage(bulkOff.error) ||
          errMessage(externalPreview.error) ||
          errMessage(checkCustom.error) ||
          errMessage(updateCustomOne.error) ||
          errMessage(updateCustomAll.error) ||
          errMessage(presetApplyPreview.error) ||
          errMessage(presetApplyConfirm.error) ||
          errMessage(presetRestorePreview.error) ||
          errMessage(presetRestoreConfirm.error) ||
          errMessage(presetSave.error) ||
          errMessage(presetDelete.error)
        }
      />
      <ActionStatus
        text={
          customCheckBusy
            ? "正本の更新を確認しています…"
            : customUpdateBusy
              ? "スキルを更新しています…"
              : bulkOff.isPending
                ? "アクティブなスキルをすべてオフにしています…"
                : apply.isPending
                  ? "変更を反映しています…"
                  : externalPreview.isPending
                    ? "外部スキルの候補を取得しています…"
                    : presetBusy
                      ? "プリセット操作を実行しています…"
                      : undefined
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        {catalog ? (
          <Link to="/global" className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
            globalに戻る
          </Link>
        ) : (
          <>
            <Link to="/global" search={{ catalog: true }} className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
              skillsを追加
            </Link>
            <Button disabled={customBusy || listBusy} onClick={() => checkCustom.mutate()}>
              {pendingLabel(customCheckBusy, "更新を確認", "確認中…")}
            </Button>
          </>
        )}
      </div>
      {!catalog && data.customUpdatesChecked ? (
        <CustomUpdatesPanel
          items={data.customUpdatable || []}
          busy={customBusy}
          onUpdateOne={(name) => updateCustomOne.mutate(name)}
          onUpdateAll={() => updateCustomAll.mutate()}
        />
      ) : null}
      {!catalog ? (
        <PresetsPanel
          presets={data.presets || []}
          hasPrevious={!!data.hasPreviousPreset}
          busy={listBusy}
          preview={presetPreview}
          onApplyRequest={(name) => presetApplyPreview.mutate(name)}
          onApplyConfirm={() => pendingPresetName && presetApplyConfirm.mutate(pendingPresetName)}
          onRestoreRequest={() => presetRestorePreview.mutate()}
          onRestoreConfirm={() => presetRestoreConfirm.mutate()}
          onOverwriteSave={(name) => presetSave.mutate({ name, overwrite: true })}
          onSaveAsNew={(name) => presetSave.mutate({ name, overwrite: false })}
          onDelete={(name) => presetDelete.mutate(name)}
          onCancelPreview={() => {
            setPresetPreview(null)
            setPendingPresetName("")
          }}
        />
      ) : null}
      {catalog ? (
        <ExternalImportForm onPreview={(s) => externalPreview.mutate(s)} busy={externalPreview.isPending} />
      ) : (
        <TristateList
          rows={data.rows || []}
          archivedRows={data.archivedRows || []}
          busy={listBusy}
          hasManagedActive={!!data.hasManagedActive}
          onApply={(states) => apply.mutate(states)}
          onBulkOff={() => bulkOff.mutate()}
        />
      )}
    </Shell>
  )
}

export function ExternalPreviewPage({ source, deck }: { source: string; deck: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const cached = qc.getQueryData(["external-preview", deck, source])

  const q = useQuery({
    queryKey: ["external-preview", deck, source],
    queryFn: () => api.previewExternal(source, deck),
    enabled: !!source,
    initialData: cached as Awaited<ReturnType<typeof api.previewExternal>> | undefined,
  })

  const install = useMutation({
    mutationFn: (skills: string[]) => api.installExternal(source, skills, deck),
    onSuccess: (data) => {
      if (deck) {
        qc.setQueryData(["project-deck", deck, true], data)
        navigate({ to: "/project-decks/$deckName", params: { deckName: deck }, search: { catalog: true } })
      } else {
        qc.setQueryData(["global", true], data)
        navigate({ to: "/global", search: { catalog: true } })
      }
    },
  })

  const addDeck = useMutation({
    mutationFn: (skills: string[]) => api.addToDeck(source, skills, deck),
    onSuccess: (data) => {
      qc.setQueryData(["project-deck", deck, true], data)
      navigate({ to: "/project-decks/$deckName", params: { deckName: deck }, search: { catalog: true } })
    },
  })

  if (!source) return <Shell><p>source がありません</p></Shell>
  if (q.isPending) return <PageLoading variant="list" />
  if (q.isError) {
    return (
      <PageError
        current={deck ? `project:${deck}` : "global"}
        message={(q.error as Error).message}
      />
    )
  }
  const data = q.data
  const previewBusy = install.isPending || addDeck.isPending

  return (
    <Shell>
      <Masthead title={data.title} />
      <Nav current={deck ? `project:${deck}` : "global"} decks={data.decks} />
      <Message text={data.message || errMessage(install.error) || errMessage(addDeck.error)} />
      <ActionStatus
        text={previewBusy ? "選択したスキルを追加しています…" : undefined}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        {deck ? (
          <Link
            to="/project-decks/$deckName"
            params={{ deckName: deck }}
            search={{ catalog: true }}
            className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm"
          >
            catalogに戻る
          </Link>
        ) : (
          <Link to="/global" search={{ catalog: true }} className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
            globalに戻る
          </Link>
        )}
      </div>
      <SelectableSkills
        rows={data.rows}
        busy={install.isPending || addDeck.isPending}
        actions={
          deck
            ? [
                { label: "deckにだけ追加", onClick: (skills) => addDeck.mutate(skills) },
                { label: "installして追加", primary: true, onClick: (skills) => install.mutate(skills) },
              ]
            : [{ label: "installしてglobalに追加", primary: true, onClick: (skills) => install.mutate(skills) }]
        }
      />
    </Shell>
  )
}

function SelectableSkills({
  rows,
  actions,
  busy,
  presetChecked = false,
}: {
  rows: SkillRow[]
  actions: { label: string; primary?: boolean; onClick: (skills: string[]) => void }[]
  busy?: boolean
  presetChecked?: boolean
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState("")

  useEffect(() => {
    setSelected(presetChecked ? rows.filter((r) => r.checked).map((r) => r.name) : [])
  }, [rows, presetChecked])

  const filtered = rows.filter((row) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    return (
      row.name.toLowerCase().includes(q) ||
      row.category.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q)
    )
  })
  const filteredNames = filtered.map((row) => row.name)
  const allFilteredSelected =
    filteredNames.length > 0 && filteredNames.every((name) => selected.includes(name))
  const someFilteredSelected = filteredNames.some((name) => selected.includes(name))

  return (
    <div>
      <div className="sticky top-0 z-20 mb-2 flex flex-wrap gap-2 rounded-[var(--radius-md)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] px-2 py-2 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
        <SearchField value={filter} onChange={setFilter} />
        <Button
          disabled={busy || filteredNames.length === 0 || allFilteredSelected}
          onClick={() =>
            setSelected((prev) => Array.from(new Set([...prev, ...filteredNames])))
          }
        >
          すべて選択
        </Button>
        <Button
          disabled={busy || !someFilteredSelected}
          onClick={() => {
            const remove = new Set(filteredNames)
            setSelected((prev) => prev.filter((name) => !remove.has(name)))
          }}
        >
          すべて解除
        </Button>
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.primary ? "primary" : "secondary"}
            disabled={busy || selected.length === 0}
            onClick={() => action.onClick(selected)}
          >
            {pendingLabel(!!busy, action.label, "処理中…")}
          </Button>
        ))}
      </div>
      {filtered.length > 0 ? (
        <div className="divide-y divide-[var(--color-rule)] rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)]">
          {filtered.map((row) => (
            <label key={row.name} className="flex cursor-pointer gap-3 px-3 py-2.5 hover:bg-[var(--color-paper-2)]">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(row.name)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked ? [...prev, row.name] : prev.filter((n) => n !== row.name),
                  )
                }
              />
              <div className="min-w-0">
                <code className="font-[family-name:var(--font-mono)] text-sm font-medium">{row.name}</code>
                <p className="m-0 mt-0.5 line-clamp-2 text-xs text-[var(--color-ink-2)]">{row.description}</p>
              </div>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ExternalSourcesPage() {
  const qc = useQueryClient()
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode)
  const q = useQuery({ queryKey: ["external-sources"], queryFn: () => api.externalSources() })
  const checkAll = useMutation({
    mutationFn: () => api.checkAllUpdates(),
    onSuccess: (data) => qc.setQueryData(["external-sources"], data),
  })
  const updateAll = useMutation({
    mutationFn: () => api.updateAll(),
    onSuccess: (data) => qc.setQueryData(["external-sources"], data),
  })

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode)
    } catch {
      /* ignore */
    }
  }, [viewMode])

  if (q.isPending) return <PageLoading variant="cards" />
  if (q.isError) {
    return <PageError current="external-sources" message={(q.error as Error).message} />
  }
  const data = q.data
  const sourcesBusy = checkAll.isPending || updateAll.isPending

  return (
    <Shell>
      <Masthead title={data.title} />
      <Nav current="external-sources" decks={data.decks} />
      <Message text={data.message || errMessage(checkAll.error) || errMessage(updateAll.error)} />
      <ActionStatus
        text={
          checkAll.isPending
            ? "外部ソースの更新を確認しています…"
            : updateAll.isPending
              ? "更新があるスキルを一括更新しています…"
              : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
        <Button onClick={() => checkAll.mutate()} disabled={sourcesBusy}>
          {pendingLabel(checkAll.isPending, "すべて更新を確認", "確認中…")}
        </Button>
        {data.totalUpdatable > 0 ? (
          <Button variant="primary" onClick={() => updateAll.mutate()} disabled={sourcesBusy}>
            {pendingLabel(
              updateAll.isPending,
              `更新があるものをすべてupdate (${data.totalUpdatable})`,
              "更新中…",
            )}
          </Button>
        ) : null}
        <ViewModeToggle value={viewMode} onChange={setViewMode} />
      </div>
      <BusyRegion busy={sourcesBusy}>
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {data.sources.map((src) => (
            <Link
              key={src.source}
              to="/external-sources/$source"
              params={{ source: src.source }}
              className="block overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)] transition-all duration-200 hover:-translate-y-1 hover:shadow-md"
            >
              <OgpPreview source={src.source} variant="grid" />
              <div className="p-3">
                <ExternalSourceMeta src={src} />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="grid gap-3">
          {data.sources.map((src) => (
            <Link
              key={src.source}
              to="/external-sources/$source"
              params={{ source: src.source }}
              className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 transition-colors duration-200 hover:bg-[var(--color-paper-2)]"
            >
              <OgpPreview source={src.source} variant="list" />
              <div className="min-w-0 flex-1">
                <ExternalSourceMeta src={src} />
              </div>
            </Link>
          ))}
        </div>
      )}
      </BusyRegion>
    </Shell>
  )
}

export function ExternalSourceDetailPage({ source }: { source: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ["external-source", source], queryFn: () => api.externalSource(source) })
  const allGlobalRef = useRef<HTMLInputElement>(null)

  const updateOne = useMutation({
    mutationFn: (skill: string) => api.updateSkill(skill),
    onSuccess: () => q.refetch(),
  })
  const updateAll = useMutation({
    mutationFn: () => api.updateAll(source),
    onSuccess: (data) => {
      if ("installed" in data) qc.setQueryData(["external-source", source], data)
    },
  })
  const remove = useMutation({
    mutationFn: (skill: string) => api.removeSkill(skill),
    onSuccess: async (data) => {
      qc.setQueryData(["external-sources"], data)
      // refetch を使うと失敗時にクエリが error 状態になり、一覧へ戻る前にエラー画面が一瞬出る。
      // 直接 API を叩いて反映することで、空になった source や失敗時も画面を飛ばさず一覧へ戻せる。
      try {
        const detail = await api.externalSource(source)
        if (detail.installed.length === 0) {
          navigate({ to: "/external-sources" })
        } else {
          qc.setQueryData(["external-source", source], detail)
        }
      } catch {
        navigate({ to: "/external-sources" })
      }
    },
  })
  const install = useMutation({
    mutationFn: (skills: string[]) => api.installExternal(source, skills, ""),
    onSuccess: () => q.refetch(),
  })
  const applyGlobal = useMutation({
    mutationFn: (states: Record<string, Tristate>) => api.apply(states),
    onMutate: async (states) => {
      await qc.cancelQueries({ queryKey: ["external-source", source] })
      const prev = qc.getQueryData<ExternalSourceDetailPayload>(["external-source", source])
      if (prev) {
        qc.setQueryData<ExternalSourceDetailPayload>(["external-source", source], {
          ...prev,
          message: "",
          installed: prev.installed.map((skill) =>
            skill.name in states
              ? {
                  ...skill,
                  state: states[skill.name]!,
                  hasUpdate: states[skill.name] === "active" ? skill.hasUpdate : false,
                }
              : skill,
          ),
          updatable: prev.updatable.filter((name) => states[name] !== "off"),
        })
      }
      return { prev }
    },
    onError: (_err, _states, ctx) => {
      if (ctx?.prev) qc.setQueryData(["external-source", source], ctx.prev)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["global"] })
      void qc.invalidateQueries({ queryKey: ["external-source", source] })
    },
  })

  const installed = q.data?.installed ?? []
  const isGlobalOn = (skill: InstalledExternal) => skill.state === "active"
  const activeCount = installed.filter(isGlobalOn).length
  const allActive = installed.length > 0 && activeCount === installed.length
  const someActive = activeCount > 0 && !allActive

  useEffect(() => {
    if (allGlobalRef.current) {
      allGlobalRef.current.indeterminate = someActive
    }
  }, [someActive])

  if (q.isPending) return <PageLoading variant="detail" />
  if (q.isError) {
    return <PageError current="external-sources" message={(q.error as Error).message} />
  }
  const data = q.data
  const detailBusy =
    updateAll.isPending ||
    updateOne.isPending ||
    remove.isPending ||
    install.isPending ||
    applyGlobal.isPending

  const setGlobal = (name: string, on: boolean) => {
    applyGlobal.mutate({ [name]: on ? "active" : "off" })
  }

  const setAllGlobal = (on: boolean) => {
    if (!installed.length) return
    const states: Record<string, Tristate> = {}
    if (on) {
      for (const skill of installed) {
        if (!isGlobalOn(skill)) states[skill.name] = "active"
      }
    } else {
      for (const skill of installed) {
        if (isGlobalOn(skill)) states[skill.name] = "off"
      }
    }
    if (Object.keys(states).length) applyGlobal.mutate(states)
  }

  return (
    <Shell>
      <Masthead title={data.title} />
      <Nav current="external-sources" decks={data.decks} />
      <Message text={data.message || errMessage(applyGlobal.error)} />
      <ActionStatus
        text={
          updateAll.isPending
            ? "このソースを一括更新しています…"
            : updateOne.isPending
              ? "スキルを更新しています…"
              : remove.isPending
                ? "管理から外しています…"
                : install.isPending
                  ? "スキルをインストールしています…"
                  : applyGlobal.isPending
                    ? "global のオン/オフを反映しています…"
                    : undefined
        }
      />
      <OgpBanner source={source} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link to="/external-sources" className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
          sourcesに戻る
        </Link>
        {data.updatable.length ? (
          <Button variant="primary" disabled={detailBusy} onClick={() => updateAll.mutate()}>
            {pendingLabel(
              updateAll.isPending,
              `このsourceをすべてupdate (${data.updatable.length})`,
              "更新中…",
            )}
          </Button>
        ) : null}
      </div>
      {installed.length ? (
        <label className="mb-3 flex cursor-pointer items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] px-3 py-2.5 text-sm">
          <input
            ref={allGlobalRef}
            type="checkbox"
            checked={allActive}
            disabled={detailBusy}
            onChange={(e) => setAllGlobal(e.target.checked)}
          />
          <span className="font-medium">すべて global オン</span>
          <span className="text-[var(--color-ink-2)]">
            ({activeCount}/{installed.length})
          </span>
        </label>
      ) : null}
      <BusyRegion busy={detailBusy} className="mb-4 grid gap-3">
        {installed.map((skill) => (
          <div key={skill.name} className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isGlobalOn(skill)}
                  disabled={detailBusy}
                  onChange={(e) => setGlobal(skill.name, e.target.checked)}
                />
                <span className="text-[var(--color-ink-2)]">global</span>
              </label>
              <h2 className="m-0 text-base font-semibold">{skill.name}</h2>
            </div>
            <p className="m-0 mb-2 text-sm text-[var(--color-ink-2)]">{skill.description}</p>
            <div className="mb-2 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
              {skill.path} · {skill.state}
            </div>
            {skill.hasUpdate ? (
              <div className="mb-2">
                <span className="text-xs text-[var(--color-warn)]">更新あり</span>
                <div className="mt-2">
                  <Button disabled={detailBusy} onClick={() => updateOne.mutate(skill.name)}>
                    {pendingLabel(updateOne.isPending, "個別update", "更新中…")}
                  </Button>
                </div>
              </div>
            ) : null}
            <Button
              disabled={detailBusy}
              onClick={() => {
                if (confirm("管理から外しますか？ global remove、skills.lock.json、project-decks に反映します。")) {
                  remove.mutate(skill.name)
                }
              }}
            >
              {pendingLabel(remove.isPending, "管理から外す", "処理中…")}
            </Button>
          </div>
        ))}
      </BusyRegion>
      {data.available.length ? (
        <>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-ink-2)]">Available to install</h2>
          <CheckboxList
            rows={data.available}
            submitLabel="選択してinstall"
            busy={install.isPending}
            onSubmit={(skills) => install.mutate(skills)}
          />
        </>
      ) : null}
    </Shell>
  )
}

export function DraftsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["drafts"], queryFn: () => api.drafts() })
  const run = useMutation({
    mutationFn: ({ action, skills }: { action: string; skills: string[] }) => api.draftsAction(action, skills),
    onSuccess: (data) => qc.setQueryData(["drafts"], data),
    onError: (err) => applyErrorBody(err, (body) => qc.setQueryData(["drafts"], body)),
  })

  if (q.isPending) return <PageLoading variant="list" />
  if (q.isError) {
    return <PageError current="drafts" message={(q.error as Error).message} />
  }
  const data = q.data

  return (
    <Shell>
      <Masthead title={data.title} />
      <Nav current="drafts" decks={data.decks} />
      <Message text={data.message || errMessage(run.error)} />
      <ActionStatus text={run.isPending ? "draft操作を実行しています…" : undefined} />
      <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 text-sm text-[var(--color-ink-2)]">
        draft解除で正式配置とlock登録を行います。global追加は ~/.agents/skills にも反映します。
      </div>
      {data.confirmSelected.length ? (
        <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3">
          <p className="m-0 mb-2 text-sm">
            選択したdraftは既に正式登録済み、または正式配置先が存在します。上書きする場合だけ続行してください。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={run.isPending} onClick={() => run.mutate({ action: "promote-force", skills: data.confirmSelected })}>
              {pendingLabel(run.isPending, "上書きしてdraft解除", "処理中…")}
            </Button>
            <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate({ action: "install-force", skills: data.confirmSelected })}>
              {pendingLabel(run.isPending, "上書きしてglobalに追加", "処理中…")}
            </Button>
          </div>
        </div>
      ) : null}
      <SelectableSkills
        rows={data.rows}
        busy={run.isPending}
        actions={[
          { label: "draft解除", onClick: (skills) => run.mutate({ action: "promote", skills }) },
          { label: "draft解除してglobalに追加", primary: true, onClick: (skills) => run.mutate({ action: "install", skills }) },
        ]}
      />
    </Shell>
  )
}

export function ProjectDeckPage({ deckName, catalog }: { deckName: string; catalog: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: ["project-deck", deckName, catalog],
    queryFn: () => api.projectDeck(deckName, catalog),
  })

  const action = useMutation({
    mutationFn: ({ act, skills }: { act: string; skills: string[] }) =>
      api.projectDeckAction(deckName, act, skills),
    onSuccess: (data) => qc.setQueryData(["project-deck", deckName, catalog], data),
  })

  const preview = useMutation({
    mutationFn: (source: string) => api.previewExternal(source, deckName),
    onSuccess: (data) => {
      qc.setQueryData(["external-preview", deckName, data.source], data)
      navigate({ to: "/external-preview", search: { source: data.source, deck: deckName } })
    },
  })

  if (q.isPending) return <PageLoading variant="list" withCounts />
  if (q.isError) {
    return <PageError current={`project:${deckName}`} message={(q.error as Error).message} />
  }
  const data = q.data

  return (
    <Shell>
      <Masthead title={data.title} />
      <Nav current={`project:${deckName}`} decks={data.decks} />
      <Message text={data.message || errMessage(action.error)} />
      <ActionStatus
        text={
          action.isPending
            ? "deckの変更を反映しています…"
            : preview.isPending
              ? "外部スキルの候補を取得しています…"
              : undefined
        }
      />
      {data.installCommands.length ? (
        <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
          <div className="mb-1 font-[family-name:var(--font-mono)] text-[10px] tracking-wide text-[var(--color-ink-2)]">
            INSTALLATION
          </div>
          <pre className="m-0 overflow-x-auto text-xs whitespace-pre-wrap">
            {data.installCommands.map((c) => `$ ${c}`).join("\n")}
          </pre>
          <Button className="mt-2" onClick={() => navigator.clipboard.writeText(data.installCommands.join("\n"))}>
            copy
          </Button>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap gap-2">
        {catalog ? (
          <Link to="/project-decks/$deckName" params={{ deckName }} className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
            deckだけ表示
          </Link>
        ) : (
          <Link to="/project-decks/$deckName" params={{ deckName }} search={{ catalog: true }} className="rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
            skillsを追加
          </Link>
        )}
      </div>
      {catalog ? (
        <ExternalImportForm deck={deckName} onPreview={(s) => preview.mutate(s)} busy={preview.isPending} />
      ) : null}
      <SelectableSkills
        rows={data.rows}
        presetChecked
        busy={action.isPending}
        actions={
          catalog
            ? [{ label: "deckを保存", primary: true, onClick: (skills) => action.mutate({ act: "save", skills }) }]
            : [
                { label: "このdeckを適用", onClick: (skills) => action.mutate({ act: "apply", skills }) },
                { label: "globalに追加", primary: true, onClick: (skills) => action.mutate({ act: "merge", skills }) },
              ]
        }
      />
    </Shell>
  )
}
