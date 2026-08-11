import { useMemo, useState, type ReactNode } from "react"
import type { SkillRow, Tristate } from "@shared/api-types"
import { Button, pendingLabel } from "./ui"

const pillClass: Record<string, string> = {
  active: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  archive: "bg-[var(--color-paper-3)] text-[var(--color-ink-2)]",
  off: "bg-[var(--color-paper-3)] text-[var(--color-ink-2)]",
  missing: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  draft: "bg-[var(--color-draft-soft)] text-[var(--color-draft)]",
  installed: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
}

type SortKey = "name" | "category" | "status" | "source"

const STATUS_ORDER: Record<string, number> = { active: 0, off: 1, archive: 2 }

/** Shared track: Name | Category | Source | Status(toggle) */
const ROW_GRID =
  "grid items-center gap-x-3 px-3 [grid-template-columns:minmax(0,1.5fr)_minmax(8rem,1fr)_4.5rem_12rem] max-md:[grid-template-columns:minmax(0,1fr)_12rem]"

function sortValue(row: SkillRow, key: SortKey): string | number {
  if (key === "name") return row.name.toLowerCase()
  if (key === "category") return row.category.toLowerCase()
  if (key === "source") return row.source.toLowerCase()
  return STATUS_ORDER[String(row.selection || "off")] ?? 99
}

export function SearchField({
  value,
  onChange,
  placeholder = "Filter skills…",
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="min-w-[240px] flex-1 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-100 focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
    />
  )
}

function SortHeader({
  sortKey,
  sortAsc,
  onToggle,
}: {
  sortKey: SortKey
  sortAsc: boolean
  onToggle: (key: SortKey) => void
}) {
  const cols: { key: SortKey; label: string; className?: string; align?: "end" }[] = [
    { key: "name", label: "Name" },
    { key: "category", label: "Category", className: "max-md:hidden" },
    { key: "source", label: "Source", className: "max-md:hidden" },
    { key: "status", label: "Status", align: "end" },
  ]

  return (
    <div className={`${ROW_GRID} bg-[var(--color-paper-2)]/70 py-2 text-[11px] font-semibold tracking-[0.02em] text-[var(--color-ink-2)] uppercase`}>
      {cols.map((col) => {
        const active = sortKey === col.key
        return (
          <button
            key={col.key}
            type="button"
            data-sort={col.key}
            onClick={() => onToggle(col.key)}
            className={`cursor-pointer transition-colors duration-100 hover:text-[var(--color-ink)] active:scale-[0.98] ${col.className || ""} ${
              col.align === "end" ? "justify-self-end text-right" : "text-left"
            } ${active ? "text-[var(--color-accent)]" : ""}`}
          >
            {col.label}
            {active ? (
              <span className="sort-indicator ml-1 text-[11px] text-[var(--color-accent)]" aria-hidden>
                {sortAsc ? "▲" : "▼"}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function TristateList({
  rows,
  archivedRows,
  onApply,
  onBulkOff,
  hasManagedActive = false,
  busy,
}: {
  rows: SkillRow[]
  archivedRows: SkillRow[]
  onApply: (states: Record<string, Tristate>) => void
  onBulkOff?: () => void
  /** True when lock-managed skills are active (bulk-off target). */
  hasManagedActive?: boolean
  busy?: boolean
}) {
  const mainRows = rows ?? []
  const archiveRows = archivedRows ?? []
  const initial = useMemo(() => {
    const map: Record<string, Tristate> = {}
    for (const row of [...mainRows, ...archiveRows]) {
      map[row.name] = (row.selection as Tristate) || "off"
    }
    return map
  }, [mainRows, archiveRows])

  const [states, setStates] = useState(initial)
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("status")
  const [sortAsc, setSortAsc] = useState(true)

  const dataKey = mainRows.map((r) => `${r.name}:${r.selection}`).join("|") + archiveRows.map((r) => r.name).join("|")
  const [prevKey, setPrevKey] = useState(dataKey)
  if (prevKey !== dataKey) {
    setPrevKey(dataKey)
    setStates(initial)
  }

  const match = (row: SkillRow) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    return (
      row.name.toLowerCase().includes(q) ||
      row.category.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      row.source.toLowerCase().includes(q)
    )
  }

  const sortedRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = mainRows.filter((row) => {
      if (!q) return true
      return (
        row.name.toLowerCase().includes(q) ||
        row.category.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q) ||
        row.source.toLowerCase().includes(q)
      )
    })
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sortKey)
      const vb = sortValue(b, sortKey)
      if (va < vb) return sortAsc ? -1 : 1
      if (va > vb) return sortAsc ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  }, [mainRows, filter, sortKey, sortAsc])

  const setOne = (name: string, value: Tristate) => {
    setStates((prev) => ({ ...prev, [name]: value }))
  }

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((v) => !v)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const dirty = Object.entries(states).some(([name, value]) => initial[name] !== value)

  return (
    <div>
      <div className="sticky top-0 z-20 mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
        <div className="flex flex-wrap gap-2 border-b border-[var(--color-rule)] px-2 py-2">
          <SearchField value={filter} onChange={setFilter} />
          <Button variant="primary" disabled={!dirty || busy} onClick={() => onApply(states)}>
            {pendingLabel(!!busy, "反映", "反映中…")}
          </Button>
          {onBulkOff ? (
            <Button
              disabled={busy || !hasManagedActive}
              onClick={() => {
                if (
                  confirm(
                    "このリポジトリ管理下のアクティブなスキルをすべてオフにします（未管理のスキルはそのまま）。直前の構成は「直前に戻す」で復元できます。よろしいですか？",
                  )
                ) {
                  onBulkOff()
                }
              }}
            >
              {pendingLabel(!!busy, "すべてオフ", "処理中…")}
            </Button>
          ) : null}
        </div>
        <SortHeader sortKey={sortKey} sortAsc={sortAsc} onToggle={toggleSort} />
      </div>
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)]">
        <div className="divide-y divide-[var(--color-rule)]">
          {sortedRows.map((row) => (
            <TristateRow key={row.name} row={row} value={states[row.name] || "off"} onChange={setOne} />
          ))}
        </div>
      </div>
      {archiveRows.length ? (
        <details className="mt-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)]">
          <summary className="cursor-pointer px-3 py-2.5 text-sm text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)]">
            Archived skills ({archiveRows.length})
          </summary>
          <div className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
            {archiveRows.filter(match).map((row) => (
              <TristateRow key={row.name} row={row} value={states[row.name] || "archive"} onChange={setOne} compact />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function StatusToggle({
  name,
  value,
  canActivate,
  onChange,
}: {
  name: string
  value: Tristate
  canActivate?: boolean
  onChange: (name: string, value: Tristate) => void
}) {
  return (
    <div
      className="inline-flex h-8 w-48 justify-self-end rounded-full border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-0.5"
      role="group"
      aria-label={`${name} status`}
    >
      {(["off", "active", "archive"] as Tristate[]).map((opt) => {
        const selected = value === opt
        return (
          <label
            key={opt}
            className={`flex flex-1 cursor-pointer items-center justify-center rounded-full px-1 text-[11px] font-semibold tracking-tight transition-[transform,background,color,box-shadow] duration-100 ease-out active:scale-[0.97] ${
              selected
                ? "bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[0_1px_2px_oklch(20%_0.02_260_/_0.18)]"
                : "text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            }`}
          >
            <input
              type="radio"
              className="sr-only"
              name={`state:${name}`}
              checked={selected}
              disabled={opt === "active" && canActivate === false}
              onChange={() => onChange(name, opt)}
            />
            {opt}
          </label>
        )
      })}
    </div>
  )
}

function TristateRow({
  row,
  value,
  onChange,
  compact = false,
}: {
  row: SkillRow
  value: Tristate
  onChange: (name: string, value: Tristate) => void
  compact?: boolean
}) {
  if (compact) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_12rem] items-center gap-x-3 px-3 py-2.5">
        <div className="min-w-0">
          <code className="font-[family-name:var(--font-mono)] text-sm font-medium">{row.name}</code>
          <p className="m-0 mt-0.5 line-clamp-2 text-xs text-[var(--color-ink-2)]">{row.description}</p>
        </div>
        <StatusToggle name={row.name} value={value} canActivate={row.can_activate} onChange={onChange} />
      </div>
    )
  }

  return (
    <div className={`${ROW_GRID} py-2.5`}>
      <div className="min-w-0">
        <code className="font-[family-name:var(--font-mono)] text-sm font-medium">{row.name}</code>
        <p className="m-0 mt-0.5 line-clamp-2 text-xs text-[var(--color-ink-2)]">{row.description}</p>
      </div>
      <div className="max-md:hidden truncate text-xs text-[var(--color-ink-2)]" title={row.category}>
        {row.category}
      </div>
      <div className="max-md:hidden truncate text-xs text-[var(--color-ink-2)]" title={row.source}>
        {row.source}
      </div>
      <StatusToggle name={row.name} value={value} canActivate={row.can_activate} onChange={onChange} />
    </div>
  )
}

export function CheckboxList({
  rows,
  onSubmit,
  submitLabel,
  extraActions,
  busy,
}: {
  rows: SkillRow[]
  onSubmit: (skills: string[]) => void
  submitLabel: string
  extraActions?: ReactNode
  busy?: boolean
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((r) => [r.name, !!r.checked])),
  )
  const [filter, setFilter] = useState("")

  const dataKey = rows.map((r) => `${r.name}:${r.checked}`).join("|")
  const [prevKey, setPrevKey] = useState(dataKey)
  if (prevKey !== dataKey) {
    setPrevKey(dataKey)
    setSelected(Object.fromEntries(rows.map((r) => [r.name, !!r.checked])))
  }

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
    filteredNames.length > 0 && filteredNames.every((name) => !!selected[name])
  const someFilteredSelected = filteredNames.some((name) => !!selected[name])

  const skills = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => k)

  return (
    <div>
      <div className="sticky top-0 z-20 mb-2 flex flex-wrap gap-2 rounded-[var(--radius-md)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] px-2 py-2 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
        <SearchField value={filter} onChange={setFilter} />
        <Button
          disabled={busy || filteredNames.length === 0 || allFilteredSelected}
          onClick={() =>
            setSelected((prev) => {
              const next = { ...prev }
              for (const name of filteredNames) next[name] = true
              return next
            })
          }
        >
          すべて選択
        </Button>
        <Button
          disabled={busy || !someFilteredSelected}
          onClick={() =>
            setSelected((prev) => {
              const next = { ...prev }
              for (const name of filteredNames) next[name] = false
              return next
            })
          }
        >
          すべて解除
        </Button>
        {extraActions}
        <Button variant="primary" disabled={busy || skills.length === 0} onClick={() => onSubmit(skills)}>
          {pendingLabel(!!busy, submitLabel, "処理中…")}
        </Button>
      </div>
      <div className="divide-y divide-[var(--color-rule)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)]">
        {filtered.map((row) => (
          <label key={row.name} className="flex cursor-pointer gap-3 px-3 py-2.5 hover:bg-[var(--color-paper-2)]">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!selected[row.name]}
              onChange={(e) => setSelected((prev) => ({ ...prev, [row.name]: e.target.checked }))}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-[family-name:var(--font-mono)] text-sm font-medium">{row.name}</code>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${pillClass[row.state] || ""}`}>
                  {row.state}
                </span>
              </div>
              <p className="m-0 mt-0.5 line-clamp-2 text-xs text-[var(--color-ink-2)]">{row.description}</p>
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-ink-2)]">
                {row.category} · {row.source}
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}

export function ExternalImportForm({
  deck = "",
  onPreview,
  busy,
}: {
  deck?: string
  onPreview: (source: string) => void
  busy?: boolean
}) {
  const [source, setSource] = useState("")
  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (source.trim()) onPreview(source.trim())
        }}
      >
        <input type="hidden" name="deck" value={deck} />
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="外部skills: owner/repo または GitHub URL"
          required
          className="min-w-[280px] flex-1 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
        />
        <Button type="submit" disabled={busy}>
          {pendingLabel(!!busy, "候補を取得", "取得中…")}
        </Button>
      </form>
    </div>
  )
}
