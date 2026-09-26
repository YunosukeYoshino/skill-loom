import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "@/api/client";
import type {
  CustomUpdatable,
  ExternalSourceDetailPayload,
  GlobalPayload,
  InstalledExternal,
  PresetPreview,
  PresetSummary,
  SkillRow,
  Tristate,
} from "@shared/api-types";
import {
  CheckboxList,
  ExternalImportForm,
  SearchField,
  TristateList,
  filterSelection,
  useLoomFilter,
} from "@/components/lists";
import { DialogFrame, useConfirm } from "@/components/dialog";
import { useListViewSearch } from "@/router-search";
import { useT, useUiSettings } from "@/settings/react";
import {
  resolveExternalView,
  type ExternalViewMode,
} from "@/settings/settings";
import {
  ActionStatus,
  BusyRegion,
  Button,
  Message,
  PageError,
  Modal,
  PageLoading,
  Toast,
  WorkbenchShell,
  pendingLabel,
} from "@/components/ui";

function errMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

function useOgp(source: string) {
  return useQuery({
    queryKey: ["ogp", source],
    queryFn: () => api.ogp(source),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={`flex rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-1 ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={
              active
                ? "inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-ink)] shadow-[0_1px_2px_oklch(20%_0.02_260/0.12)] transition-[transform,background,color,box-shadow] duration-100 ease-out active:scale-[0.96]"
                : "inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-2)] transition-[transform,background,color] duration-100 ease-out hover:bg-[var(--surface)] hover:text-[var(--color-ink)] active:scale-[0.96]"
            }
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const gridIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1"
      y="1"
      width="4.5"
      height="4.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="8.5"
      y="1"
      width="4.5"
      height="4.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="1"
      y="8.5"
      width="4.5"
      height="4.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="8.5"
      y="8.5"
      width="4.5"
      height="4.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const listIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1"
      y="2"
      width="12"
      height="2.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="1"
      y="6.75"
      width="12"
      height="2.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <rect
      x="1"
      y="11.5"
      width="12"
      height="2.5"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

function ViewModeToggle({
  value,
  onChange,
}: {
  value: ExternalViewMode;
  onChange: (mode: ExternalViewMode) => void;
}) {
  const t = useT();
  return (
    <SegmentedControl
      className="ml-auto"
      ariaLabel={t("view.aria")}
      value={value}
      onChange={onChange}
      options={[
        { value: "grid", label: t("view.grid"), icon: gridIcon },
        { value: "list", label: t("view.list"), icon: listIcon },
      ]}
    />
  );
}

function OgpPreview({
  source,
  variant = "list",
}: {
  source: string;
  variant?: ExternalViewMode;
}) {
  const q = useOgp(source);

  if (variant === "list") {
    if (!q.data?.image) return null;
    return (
      <img
        src={q.data.image}
        alt=""
        width={112}
        height={64}
        loading="lazy"
        decoding="async"
        className="h-16 w-28 flex-none rounded-[calc(var(--radius-sm)-4px)] border border-[var(--color-rule)] object-cover outline-1 outline-[oklch(0_0_0/0.1)]"
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
    );
  }

  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-[var(--color-paper-2)] to-[var(--color-paper-3)]">
      {q.data?.image ? (
        <img
          src={q.data.image}
          alt=""
          width={640}
          height={360}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </div>
  );
}

function ExternalSourceMeta({
  src,
}: {
  src: {
    source: string;
    owner: string;
    repo: string;
    skills: { length: number };
    statusLabel: string;
  };
}) {
  return (
    <>
      <h2 className="m-0 mb-1.5 text-base font-semibold text-[var(--color-ink)]">
        {src.source}
      </h2>
      <div className="flex flex-wrap gap-3 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
        <span>author {src.owner}</span>
        <span>repo {src.repo}</span>
        <span>skills {src.skills.length}</span>
        {src.statusLabel ? <span>{src.statusLabel}</span> : null}
      </div>
    </>
  );
}

function OgpBanner({ source }: { source: string }) {
  const q = useOgp(source);
  if (!q.data || (!q.data.image && !q.data.description)) return null;
  return (
    <div className="mb-3 flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
      {q.data.image ? (
        <img
          src={q.data.image}
          alt=""
          loading="lazy"
          className="h-20 w-36 flex-none rounded-[calc(var(--radius-sm)-2px)] border border-[var(--color-rule)] object-cover outline-1 outline-[oklch(0_0_0/0.1)]"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      <div className="min-w-0">
        <p className="m-0 mb-1 text-sm font-semibold text-[var(--color-ink)]">
          {q.data.title || source}
        </p>
        {q.data.description ? (
          <p className="m-0 text-xs text-[var(--color-ink-2)]">
            {q.data.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function applyErrorBody<T>(err: unknown, set: (body: T) => void) {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as T & { page?: unknown; decks?: unknown };
    // FastAPI 既定の {detail} など不完全なエラー体でキャッシュを壊さない
    if (body.page == null && !Array.isArray(body.decks)) return;
    set(err.body as T);
  }
}

function CustomUpdatesPanel({
  items,
  busy,
  onUpdateOne,
  onUpdateAll,
}: {
  items: CustomUpdatable[];
  busy?: boolean;
  onUpdateOne: (name: string) => void;
  onUpdateAll: () => void;
}) {
  const t = useT();
  if (!items.length) {
    return (
      <div
        role="status"
        className="mb-4 flex items-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] px-3 py-2.5 text-sm"
      >
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.2 5 8.5l4.5-5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="min-w-0">
          <b className="font-semibold">{t("custom.upToDate")}</b>
          <span className="block text-xs text-[var(--color-ink-2)]">
            {t("custom.upToDateBody")}
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold [font-variant-numeric:tabular-nums]">
          {t("custom.newerSource", { count: items.length })}
        </h2>
        <Button variant="primary" disabled={busy} onClick={onUpdateAll}>
          <span className="[font-variant-numeric:tabular-nums]">
            {pendingLabel(
              !!busy,
              t("custom.updateAll", { count: items.length }),
              t("common.updating")
            )}
          </span>
        </Button>
      </div>
      <div className="grid gap-3">
        {items.map((item) => (
          <details
            key={item.name}
            className="rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-3"
          >
            <summary className="min-h-10 cursor-pointer list-none">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-[family-name:var(--font-mono)] text-sm font-medium">
                  {item.name}
                </code>
                <span className="rounded px-1.5 py-0.5 text-[11px] bg-[var(--color-warn-soft)] text-[var(--color-warn-text)]">
                  {t("custom.newerSourceBadge")}
                </span>
                <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
                  {item.state} · {item.repoPath}
                </span>
              </div>
            </summary>
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy} onClick={() => onUpdateOne(item.name)}>
                  {pendingLabel(
                    !!busy,
                    t("custom.updateOne"),
                    t("common.updating")
                  )}
                </Button>
              </div>
              {item.skillDiff ? (
                <pre className="max-h-72 overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] p-2 text-xs leading-relaxed">
                  {item.skillDiff}
                </pre>
              ) : (
                <p className="m-0 text-xs text-[var(--color-ink-2)]">
                  {t("custom.diffNote")}
                </p>
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
  );
}

function PresetPreviewPanel({ preview }: { preview: PresetPreview }) {
  const t = useT();
  const delta = preview.preview || {
    active: [],
    archive: [],
    off: [],
    install: [],
    unresolved: [],
  };
  const rows = [
    { label: t("preset.becomeActive"), items: delta.active || [] },
    { label: t("preset.becomeArchive"), items: delta.archive || [] },
    { label: t("preset.becomeOff"), items: delta.off || [] },
    { label: t("preset.willInstall"), items: delta.install || [] },
    {
      label:
        preview.name === "_last"
          ? t("preset.restoreSkip")
          : t("preset.unresolved"),
      items: delta.unresolved || [],
    },
  ].filter((row) => row.items.length > 0);

  if (!rows.length) {
    return (
      <p className="m-0 mt-1.5 text-sm text-[var(--color-ink-2)]">
        {t("preset.noChanges")}
      </p>
    );
  }

  return (
    <ul className="m-0 mt-3.5 max-h-[50vh] list-none divide-y divide-[var(--color-rule)] overflow-auto rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 py-0">
      {rows.map((row) => (
        <li key={row.label} className="py-2">
          <p className="m-0 flex items-baseline justify-between gap-3 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase">
            {row.label}
            <b className="text-xs font-semibold text-[var(--color-ink)] [font-variant-numeric:tabular-nums]">
              {row.items.length}
            </b>
          </p>
          <p className="m-0 mt-1 font-[family-name:var(--font-mono)] text-xs break-words text-[var(--color-ink)]">
            {row.items.join(", ")}
          </p>
        </li>
      ))}
    </ul>
  );
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
  presets: PresetSummary[];
  hasPrevious: boolean;
  busy?: boolean;
  preview: PresetPreview | null;
  onApplyRequest: (name: string) => void;
  onApplyConfirm: () => void;
  onRestoreRequest: () => void;
  onRestoreConfirm: () => void;
  onOverwriteSave: (name: string) => void;
  onSaveAsNew: (name: string) => void;
  onDelete: (name: string) => void;
  onCancelPreview: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(() => presets[0]?.name || "");
  const [savingAsNew, setSavingAsNew] = useState(false);

  useEffect(() => {
    if (presets.length && !presets.some((preset) => preset.name === selected)) {
      setSelected(presets[0]?.name || "");
    }
  }, [presets, selected]);

  const saveAsNew = (name: string) => {
    onSaveAsNew(name);
    setSelected(name);
    setSavingAsNew(false);
  };

  // 実行中またはプレビュー確認中は、パネルの操作をすべて止める
  const locked = busy || !!preview;
  const canUseSelected = Boolean(selected) && !locked;

  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold">{t("preset.title")}</h2>
        <PresetSelect
          presets={presets}
          value={selected}
          onChange={setSelected}
          disabled={locked}
        />
        <Button
          variant="primary"
          disabled={!canUseSelected}
          onClick={() => onApplyRequest(selected)}
        >
          {pendingLabel(!!busy, t("common.apply"), t("common.processing"))}
        </Button>
        <SaveMenu
          disabled={locked}
          canOverwrite={canUseSelected}
          onOverwrite={() => onOverwriteSave(selected)}
          onSaveAs={() => setSavingAsNew(true)}
        />
        {hasPrevious ? (
          <Button disabled={locked} onClick={onRestoreRequest}>
            {pendingLabel(
              !!busy,
              t("preset.restoreLast"),
              t("common.processing")
            )}
          </Button>
        ) : null}
        <DeletePresetButton
          name={selected}
          busy={busy}
          disabled={!canUseSelected}
          onDelete={onDelete}
        />
      </div>
      <SavePresetModal
        open={savingAsNew}
        busy={busy}
        disabled={!!preview}
        onSave={saveAsNew}
        onClose={() => setSavingAsNew(false)}
      />
      <PresetPreviewModal
        preview={preview}
        busy={busy}
        onApplyConfirm={onApplyConfirm}
        onRestoreConfirm={onRestoreConfirm}
        onCancel={onCancelPreview}
      />
    </div>
  );
}
function DeletePresetButton({
  name,
  busy,
  disabled,
  onDelete,
}: {
  name: string;
  busy?: boolean;
  disabled: boolean;
  onDelete: (name: string) => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const requestDelete = async () => {
    const ok = await confirm({
      title: t("preset.deleteConfirm", { name }),
      body: t("preset.deleteBody"),
      confirmLabel: t("preset.deleteAction"),
      cancelLabel: t("preset.keep"),
      tone: "danger",
    });
    if (ok) onDelete(name);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={requestDelete}
      className="ml-auto min-h-10 cursor-pointer rounded-[var(--radius-sm)] px-2 py-1.5 text-sm text-[var(--color-ink-2)] transition-[transform,color,background] duration-100 ease-out hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {pendingLabel(!!busy, t("common.delete"), t("common.processing"))}
    </button>
  );
}

function PresetSelect({
  presets,
  value,
  onChange,
  disabled,
}: {
  presets: PresetSummary[];
  value: string;
  onChange: (name: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <select
      aria-label={t("preset.selectAria")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || !presets.length}
      className="min-h-10 min-w-[180px] rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-2.5 py-1.5 text-sm text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {presets.length ? (
        presets.map((preset) => (
          <option key={preset.name} value={preset.name}>
            {preset.name} ({preset.skillCount})
          </option>
        ))
      ) : (
        <option value="">{t("preset.none")}</option>
      )}
    </select>
  );
}

const menuItemClass =
  "block min-h-10 w-full cursor-pointer rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-sm transition-[transform,background,color] duration-100 ease-out hover:bg-[var(--color-paper-2)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45";

/** 保存 ▾ メニュー (上書き / 名前を付けて保存)。外側クリックと Esc で閉じる */
function SaveMenu({
  disabled,
  canOverwrite,
  onOverwrite,
  onSaveAs,
}: {
  disabled: boolean;
  canOverwrite: boolean;
  onOverwrite: () => void;
  onSaveAs: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((prev) => !prev)}
      >
        {t("common.save")}
        <span
          className="ml-1 text-[10px] leading-none text-[var(--color-ink-2)]"
          aria-hidden
        >
          ▾
        </span>
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-[calc(100%+4px)] left-0 z-30 min-w-[11rem] rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lift)]"
        >
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            disabled={!canOverwrite}
            onClick={choose(onOverwrite)}
          >
            {t("preset.overwrite")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            disabled={disabled}
            onClick={choose(onSaveAs)}
          >
            {t("preset.saveAs")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 現在のスキル構成を新しい名前のプリセットとして保存するダイアログ */
function SavePresetModal({
  open,
  busy,
  disabled,
  onSave,
  onClose,
}: {
  open: boolean;
  busy?: boolean;
  disabled: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setName("");
    onClose();
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setName("");
    onSave(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) close();
      }}
      labelledBy="save-preset-title"
    >
      <DialogFrame
        titleId="save-preset-title"
        title={t("preset.saveAsTitle")}
        footer={
          <>
            <Button disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !name.trim() || disabled}
              onClick={save}
            >
              {pendingLabel(!!busy, t("common.save"), t("common.processing"))}
            </Button>
          </>
        }
      >
        <p className="m-0 mt-1.5 text-sm text-[var(--color-ink-2)] [text-wrap:pretty]">
          {t("preset.saveAsBody")}
        </p>
        <label
          htmlFor="new-preset-name"
          className="mt-3.5 mb-1.5 block font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase"
        >
          {t("preset.newName")}
        </label>
        <input
          id="new-preset-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          disabled={busy || disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("preset.newPlaceholder")}
          className="min-h-10 w-full rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 py-2 font-[family-name:var(--font-mono)] text-sm outline-none transition-[border-color,box-shadow] duration-100 focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
        />
      </DialogFrame>
    </Modal>
  );
}

/** プリセット適用 / 直前に戻す の差分プレビューと実行確認 */
function PresetPreviewModal({
  preview,
  busy,
  onApplyConfirm,
  onRestoreConfirm,
  onCancel,
}: {
  preview: PresetPreview | null;
  busy?: boolean;
  onApplyConfirm: () => void;
  onRestoreConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={!!preview}
      onClose={() => {
        if (!busy) onCancel();
      }}
      labelledBy="preset-preview-title"
    >
      {preview ? (
        <PresetPreviewDialog
          preview={preview}
          busy={busy}
          onConfirm={
            preview.name === "_last" ? onRestoreConfirm : onApplyConfirm
          }
          onCancel={onCancel}
        />
      ) : null}
    </Modal>
  );
}

function PresetPreviewDialog({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: PresetPreview;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <DialogFrame
      titleId="preset-preview-title"
      title={
        preview.name === "_last"
          ? t("preset.applyLast")
          : t("preset.applyNamed", { name: preview.name })
      }
      footer={
        <>
          <Button disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || preview.blocked}
            onClick={onConfirm}
          >
            {pendingLabel(!!busy, t("common.run"), t("common.processing"))}
          </Button>
        </>
      }
    >
      <PresetPreviewPanel preview={preview} />
    </DialogFrame>
  );
}

/** "Add skills" — owner/repo を受けて候補取得へ進むモーダル (max-sm はボトムシート) */
function AddSkillsDialog({
  open,
  busy,
  error,
  onClose,
  onFetch,
}: {
  open: boolean;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onFetch: (source: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState("");
  const close = () => {
    if (busy) return;
    setSource("");
    onClose();
  };
  return (
    <Modal open={open} onClose={close} labelledBy="add-skills-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim() && !busy) onFetch(source.trim());
        }}
      >
        <DialogFrame
          titleId="add-skills-title"
          title={t("global.addSkills")}
          footer={
            <>
              <Button disabled={busy} onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !source.trim()}
              >
                {pendingLabel(!!busy, t("import.fetch"), t("import.fetching"))}
              </Button>
            </>
          }
        >
          <p className="m-0 mt-1.5 text-sm text-[var(--color-ink-2)] [text-wrap:pretty]">
            {t("addSkills.body")}
          </p>
          <label
            htmlFor="add-skills-source"
            className="mt-3.5 mb-1.5 block font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase"
          >
            {t("import.aria")}
          </label>
          <input
            id="add-skills-source"
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={t("import.placeholder")}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className="min-h-10 w-full rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 py-2 font-[family-name:var(--font-mono)] text-sm outline-none transition-[border-color,box-shadow] duration-100 focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
          />
          {error ? (
            <p
              role="alert"
              className="m-0 mt-2.5 rounded-[var(--radius-sm)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-text)] [text-wrap:pretty]"
            >
              {error}
            </p>
          ) : (
            <p className="m-0 mt-2 text-xs text-[var(--color-ink-2)]">
              {t("addSkills.hint")}
            </p>
          )}
        </DialogFrame>
      </form>
    </Modal>
  );
}

export function GlobalPage({ catalog }: { catalog: boolean }) {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const q = useQuery({
    queryKey: ["global", catalog],
    queryFn: () => api.global(catalog),
  });
  const [presetPreview, setPresetPreview] = useState<PresetPreview | null>(
    null
  );
  const [pendingPresetName, setPendingPresetName] = useState("");
  const [toast, setToast] = useState<{
    id: number;
    text: string;
    undo: boolean;
  } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  const onGlobalError = (err: unknown) =>
    applyErrorBody(err, (body) => qc.setQueryData(["global", false], body));

  /** 成功結果の message はインラインではなくトーストへ回す */
  const settle = (data: GlobalPayload, undo = false) => {
    qc.setQueryData(["global", false], { ...data, message: undefined });
    if (data.message) {
      setToast({
        id: Date.now(),
        text: data.message,
        undo: undo && !!data.hasPreviousPreset,
      });
    }
  };

  const apply = useMutation({
    mutationFn: (states: Record<string, Tristate>) => api.apply(states),
    onSuccess: (data) => settle(data, true),
    onError: (err) =>
      applyErrorBody(err, (body) => qc.setQueryData(["global", catalog], body)),
  });

  const bulkOff = useMutation({
    mutationFn: () => api.bulkOff(),
    onSuccess: (data) => settle(data, true),
    onError: onGlobalError,
  });

  const restoreAll = useMutation({
    mutationFn: () => api.restoreAll(true),
    onSuccess: (data) => settle(data),
    onError: onGlobalError,
  });

  // 確認ダイアログを待つ間は pending にしない (onSuccess で await しない)
  const restoreAllPreview = useMutation({
    mutationFn: () => api.restoreAll(false),
    onSuccess: (preview) => {
      void confirm({
        title: t("global.restoreAllConfirm"),
        body: preview.message || undefined,
        confirmLabel: t("global.restoreAll"),
      }).then((ok) => {
        if (ok) restoreAll.mutate();
      });
    },
    onError: onGlobalError,
  });
  const restoreAllBusy = restoreAllPreview.isPending || restoreAll.isPending;

  const checkCustom = useMutation({
    mutationFn: () => api.checkCustomUpdates(),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: onGlobalError,
  });

  const updateCustomOne = useMutation({
    mutationFn: (skill: string) => api.updateCustomSkill(skill),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: onGlobalError,
  });

  const updateCustomAll = useMutation({
    mutationFn: () => api.updateAllCustomSkills(),
    onSuccess: (data) => qc.setQueryData(["global", false], data),
    onError: onGlobalError,
  });

  const externalPreview = useMutation({
    mutationFn: (source: string) => api.previewExternal(source, ""),
    onSuccess: (data) => {
      qc.setQueryData(["external-preview", "", data.source], data);
      navigate({
        to: "/external-preview",
        search: { source: data.source, deck: "" },
      });
    },
  });

  const presetApplyPreview = useMutation({
    mutationFn: (name: string) => api.applyPreset(name, false),
    onSuccess: (data) => {
      if (data.presetPreview) {
        setPresetPreview(data.presetPreview);
        setPendingPresetName(data.presetPreview.name);
      }
    },
    onError: (err) =>
      applyErrorBody(err, (body) => {
        qc.setQueryData(["global", false], body);
        if (body && typeof body === "object" && "presetPreview" in body) {
          setPresetPreview(
            (body as { presetPreview?: PresetPreview }).presetPreview || null
          );
        }
      }),
  });

  const presetApplyConfirm = useMutation({
    mutationFn: (name: string) => api.applyPreset(name, true),
    onSuccess: (data) => {
      setPresetPreview(null);
      setPendingPresetName("");
      settle(data, true);
    },
    onError: onGlobalError,
  });

  const presetRestorePreview = useMutation({
    mutationFn: () => api.restorePreset(false),
    onSuccess: (data) => {
      if (data.presetPreview) {
        setPresetPreview({ ...data.presetPreview, name: "_last" });
      }
    },
    onError: (err) =>
      applyErrorBody(err, (body) => {
        qc.setQueryData(["global", false], body);
        if (body && typeof body === "object" && "presetPreview" in body) {
          setPresetPreview({
            ...(body as { presetPreview: PresetPreview }).presetPreview,
            name: "_last",
          });
        }
      }),
  });

  const presetRestoreConfirm = useMutation({
    mutationFn: () => api.restorePreset(true),
    onSuccess: (data) => {
      setPresetPreview(null);
      settle(data);
    },
    onError: onGlobalError,
  });

  const presetSave = useMutation({
    mutationFn: ({ name, overwrite }: { name: string; overwrite: boolean }) =>
      api.savePreset(name, overwrite),
    onSuccess: (data) => settle(data),
    onError: onGlobalError,
  });

  const presetDelete = useMutation({
    mutationFn: (name: string) => api.deletePreset(name),
    onSuccess: (data) => settle(data),
    onError: onGlobalError,
  });

  if (q.isPending) return <PageLoading variant="list" />;
  if (q.isError) {
    return <PageError current="global" message={(q.error as Error).message} />;
  }
  const data = q.data;
  const customCheckBusy = checkCustom.isPending;
  const customUpdateBusy =
    updateCustomOne.isPending || updateCustomAll.isPending;
  const customBusy = customCheckBusy || customUpdateBusy;
  const presetBusy =
    presetApplyPreview.isPending ||
    presetApplyConfirm.isPending ||
    presetRestorePreview.isPending ||
    presetRestoreConfirm.isPending ||
    presetSave.isPending ||
    presetDelete.isPending;
  const listBusy =
    apply.isPending || bulkOff.isPending || restoreAllBusy || presetBusy;

  return (
    <WorkbenchShell
      title={catalog ? "Catalog" : "Global"}
      overline={
        catalog ? t("global.catalogOverline") : t("global.projectionOverline")
      }
      sub={
        catalog
          ? t("global.catalogSub")
          : `${data.rows?.length ?? 0} skills${
              data.counts ? ` · active ${data.counts.active}` : ""
            }`
      }
      counts={data.counts}
      current="global"
      decks={data.decks || []}
      searchable
      drawer={
        !catalog ? (
          <>
            {data.customUpdatesChecked ? (
              <CustomUpdatesPanel
                items={data.customUpdatable || []}
                busy={customBusy}
                onUpdateOne={(name) => updateCustomOne.mutate(name)}
                onUpdateAll={() => updateCustomAll.mutate()}
              />
            ) : null}
            <PresetsPanel
              presets={data.presets || []}
              hasPrevious={!!data.hasPreviousPreset}
              busy={listBusy}
              preview={presetPreview}
              onApplyRequest={(name) => presetApplyPreview.mutate(name)}
              onApplyConfirm={() =>
                pendingPresetName &&
                presetApplyConfirm.mutate(pendingPresetName)
              }
              onRestoreRequest={() => presetRestorePreview.mutate()}
              onRestoreConfirm={() => presetRestoreConfirm.mutate()}
              onOverwriteSave={(name) =>
                presetSave.mutate({ name, overwrite: true })
              }
              onSaveAsNew={(name) =>
                presetSave.mutate({ name, overwrite: false })
              }
              onDelete={(name) => presetDelete.mutate(name)}
              onCancelPreview={() => {
                setPresetPreview(null);
                setPendingPresetName("");
              }}
            />
          </>
        ) : undefined
      }
    >
      <Message
        text={
          data.message ||
          errMessage(apply.error) ||
          errMessage(bulkOff.error) ||
          errMessage(restoreAllPreview.error) ||
          errMessage(restoreAll.error) ||
          (catalog ? errMessage(externalPreview.error) : "") ||
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
            ? t("status.checkSource")
            : customUpdateBusy
              ? t("status.updatingSkills")
              : bulkOff.isPending
                ? t("status.bulkOff")
                : restoreAllBusy
                  ? t("status.restoreAll")
                  : apply.isPending
                    ? t("status.applying")
                    : externalPreview.isPending
                      ? t("status.fetchCandidates")
                      : presetBusy
                        ? t("status.preset")
                        : undefined
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        {catalog ? (
          <Link
            to="/global"
            className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm transition-[background,border-color] duration-100 ease-out hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
          >
            {t("global.backToGlobal")}
          </Link>
        ) : (
          <>
            <Button
              variant="primary"
              aria-haspopup="dialog"
              onClick={() => {
                externalPreview.reset();
                setAddOpen(true);
              }}
            >
              <span aria-hidden>+</span>
              {t("global.addSkills")}
            </Button>
            <Button
              disabled={customBusy || listBusy}
              onClick={() => checkCustom.mutate()}
            >
              {pendingLabel(
                customCheckBusy,
                t("global.checkUpdates"),
                t("common.checking")
              )}
            </Button>
            <Button
              disabled={customBusy || listBusy}
              onClick={() => restoreAllPreview.mutate()}
            >
              {pendingLabel(
                restoreAllBusy,
                t("global.restoreAll"),
                t("common.processing")
              )}
            </Button>
          </>
        )}
      </div>
      {catalog ? (
        <ExternalImportForm
          onPreview={(s) => externalPreview.mutate(s)}
          busy={externalPreview.isPending}
        />
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
      <AddSkillsDialog
        open={addOpen}
        busy={externalPreview.isPending}
        error={errMessage(externalPreview.error)}
        onClose={() => setAddOpen(false)}
        onFetch={(source) => externalPreview.mutate(source)}
      />
      <Toast
        id={toast?.id}
        text={toast?.text}
        action={
          toast?.undo
            ? {
                label: t("preset.restoreLast"),
                onClick: () => presetRestorePreview.mutate(),
              }
            : undefined
        }
        onDismiss={dismissToast}
      />
    </WorkbenchShell>
  );
}

export function ExternalPreviewPage({
  source,
  deck,
}: {
  source: string;
  deck: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cached = qc.getQueryData(["external-preview", deck, source]);

  const q = useQuery({
    queryKey: ["external-preview", deck, source],
    queryFn: () => api.previewExternal(source, deck),
    enabled: !!source,
    initialData: cached as
      | Awaited<ReturnType<typeof api.previewExternal>>
      | undefined,
  });

  const install = useMutation({
    mutationFn: (skills: string[]) => api.installExternal(source, skills, deck),
    onSuccess: (data) => {
      if (deck) {
        qc.setQueryData(["project-deck", deck, true], data);
        navigate({
          to: "/project-decks/$deckName",
          params: { deckName: deck },
          search: { catalog: true },
        });
      } else {
        qc.setQueryData(["global", true], data);
        navigate({ to: "/global", search: { catalog: true } });
      }
    },
  });

  const addDeck = useMutation({
    mutationFn: (skills: string[]) => api.addToDeck(source, skills, deck),
    onSuccess: (data) => {
      qc.setQueryData(["project-deck", deck, true], data);
      navigate({
        to: "/project-decks/$deckName",
        params: { deckName: deck },
        search: { catalog: true },
      });
    },
  });

  if (!source)
    return (
      <WorkbenchShell title={t("preview.title")} current="global">
        <p className="m-0">{t("preview.noSource")}</p>
      </WorkbenchShell>
    );
  if (q.isPending) return <PageLoading variant="list" />;
  if (q.isError) {
    return (
      <PageError
        current={deck ? `project:${deck}` : "global"}
        message={(q.error as Error).message}
      />
    );
  }
  const data = q.data;
  const previewBusy = install.isPending || addDeck.isPending;

  return (
    <WorkbenchShell
      title={data.title}
      overline={t("preview.overline")}
      current={deck ? `project:${deck}` : "global"}
      decks={data.decks}
      searchable
    >
      <Message
        text={
          data.message || errMessage(install.error) || errMessage(addDeck.error)
        }
      />
      <ActionStatus
        text={previewBusy ? t("status.addingSelected") : undefined}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        {deck ? (
          <Link
            to="/project-decks/$deckName"
            params={{ deckName: deck }}
            search={{ catalog: true }}
            className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm transition-[background,border-color] duration-100 ease-out hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
          >
            {t("preview.backToCatalog")}
          </Link>
        ) : (
          <Link
            to="/global"
            search={{ catalog: true }}
            className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm transition-[background,border-color] duration-100 ease-out hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
          >
            {t("global.backToGlobal")}
          </Link>
        )}
      </div>
      <SelectableSkills
        rows={data.rows}
        busy={install.isPending || addDeck.isPending}
        actions={
          deck
            ? [
                {
                  label: t("preview.addDeckOnly"),
                  onClick: (skills) => addDeck.mutate(skills),
                },
                {
                  label: t("preview.installAdd"),
                  primary: true,
                  onClick: (skills) => install.mutate(skills),
                },
              ]
            : [
                {
                  label: t("preview.installGlobal"),
                  primary: true,
                  onClick: (skills) => install.mutate(skills),
                },
              ]
        }
      />
    </WorkbenchShell>
  );
}

function SelectableSkills({
  rows,
  actions,
  busy,
  presetChecked = false,
}: {
  rows: SkillRow[];
  actions: {
    label: string;
    primary?: boolean;
    onClick: (skills: string[]) => void;
  }[];
  busy?: boolean;
  presetChecked?: boolean;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useLoomFilter();

  useEffect(() => {
    setSelected(
      presetChecked ? rows.filter((r) => r.checked).map((r) => r.name) : []
    );
  }, [rows, presetChecked]);

  const { filtered, filteredNames, allFilteredSelected, someFilteredSelected } =
    filterSelection(rows, filter, (name) => selected.includes(name));

  return (
    <div>
      <div className="sticky top-[70px] z-20 mb-2 flex flex-wrap gap-2 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] px-2 py-2 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
        <SearchField value={filter} onChange={setFilter} />
        <Button
          disabled={busy || filteredNames.length === 0 || allFilteredSelected}
          onClick={() =>
            setSelected((prev) =>
              Array.from(new Set([...prev, ...filteredNames]))
            )
          }
        >
          {t("common.selectAll")}
        </Button>
        <Button
          disabled={busy || !someFilteredSelected}
          onClick={() => {
            const remove = new Set(filteredNames);
            setSelected((prev) => prev.filter((name) => !remove.has(name)));
          }}
        >
          {t("common.clearAll")}
        </Button>
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.primary ? "primary" : "secondary"}
            disabled={busy || selected.length === 0}
            onClick={() => action.onClick(selected)}
          >
            {pendingLabel(!!busy, action.label, t("common.processing"))}
          </Button>
        ))}
      </div>
      {filtered.length > 0 ? (
        <div className="divide-y divide-[var(--color-rule)] rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)]">
          {filtered.map((row) => (
            <label
              key={row.name}
              className="loom-row flex cursor-pointer gap-3 px-3 py-2.5 hover:bg-[var(--color-paper-2)]"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(row.name)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked
                      ? [...prev, row.name]
                      : prev.filter((n) => n !== row.name)
                  )
                }
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all font-[family-name:var(--font-mono)] text-sm font-medium">
                    {row.name}
                  </code>
                  {row.category?.startsWith("[名前空間:") && (
                    <span className="rounded bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn-text)]">
                      {t("list.collisionBadge")}
                    </span>
                  )}
                </div>
                <p className="m-0 mt-0.5 line-clamp-2 text-xs text-[var(--color-ink-2)] [text-wrap:pretty]">
                  {row.description}
                </p>
              </div>
            </label>
          ))}
        </div>
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--color-ink-2)] [text-wrap:pretty]">
          {t("common.noMatches")}
        </div>
      )}
    </div>
  );
}

type DiscoverCard = {
  source: string;
  skillId: string;
  name: string;
  installs: number;
};

const compactInstalls = new Intl.NumberFormat("en-US", {
  notation: "compact",
});

function DiscoverSearch() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  // queryKey が検索語を保持するので、前の検索語の結果が新しい入力に残らない
  const search = useQuery({
    queryKey: ["discover-search", term],
    queryFn: () => api.discoverSearch(term),
    enabled: term.length >= 2,
  });
  const preview = useMutation({
    mutationFn: (source: string) => api.previewExternal(source, ""),
    onSuccess: (data) => {
      qc.setQueryData(["external-preview", "", data.source], data);
      navigate({
        to: "/external-preview",
        search: { source: data.source, deck: "" },
      });
    },
  });

  // 入力 debounce: 2文字以上で検索語を確定、未満なら結果を消す
  useEffect(() => {
    const q = query.trim();
    const id = setTimeout(() => setTerm(q.length >= 2 ? q : ""), 300);
    return () => clearTimeout(id);
  }, [query]);

  const searched = search.data !== undefined;
  const cards: DiscoverCard[] = searched
    ? search.data.results.flatMap((r) =>
        r.skills.map((s) => ({
          source: r.source,
          skillId: s.skillId,
          name: s.name,
          installs: s.installs,
        }))
      )
    : [];
  const busy = preview.isPending;

  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--color-ink-2)]">
          {t("discover.title")}
        </span>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("discover.placeholder")}
        />
      </div>
      {search.isError ? (
        <p className="mt-3 text-sm text-[var(--color-ink-2)]">
          {errMessage(search.error)}
        </p>
      ) : null}
      {searched ? (
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-2)]">
          {cards.length}
        </p>
      ) : null}
      {!searched ? null : cards.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-ink-2)]">
          {t("discover.empty")}
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cards.map((card) => {
            const owner = card.source.split("/")[0] ?? "";
            return (
              <button
                key={`${card.source}/${card.skillId}`}
                type="button"
                onClick={() => preview.mutate(card.source)}
                disabled={busy}
                className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 text-left transition-colors duration-200 hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
              >
                <img
                  src={`https://github.com/${owner}.png`}
                  alt=""
                  loading="lazy"
                  className="h-10 w-10 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {card.name}
                  </span>
                  <span className="block truncate text-sm text-[var(--color-ink-2)] [font-variant-numeric:tabular-nums]">
                    {owner} · ↓ {compactInstalls.format(card.installs)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExternalSourcesPage() {
  const t = useT();
  const qc = useQueryClient();
  const [{ view: urlView }, setUrlSearch] = useListViewSearch();
  const { settings, update } = useUiSettings();
  // URL ?view= を優先 (リロード・戻る/進む・共有リンク)、なければ Settings の既定値
  const viewMode = resolveExternalView(urlView, settings);
  const setViewMode = (mode: ExternalViewMode) => {
    setUrlSearch({ view: mode });
    update({ externalViewMode: mode });
  };
  const q = useQuery({
    queryKey: ["external-sources"],
    queryFn: () => api.externalSources(),
  });
  const checkAll = useMutation({
    mutationFn: () => api.checkAllUpdates(),
    onSuccess: (data) => qc.setQueryData(["external-sources"], data),
  });
  const updateAll = useMutation({
    mutationFn: () => api.updateAll(),
    onSuccess: (data) => qc.setQueryData(["external-sources"], data),
  });

  if (q.isPending) return <PageLoading variant="cards" />;
  if (q.isError) {
    return (
      <PageError
        current="external-sources"
        message={(q.error as Error).message}
      />
    );
  }
  const data = q.data;
  const sourcesBusy = checkAll.isPending || updateAll.isPending;

  return (
    <WorkbenchShell
      title={data.title}
      overline={t("sources.overline")}
      current="external-sources"
      decks={data.decks}
    >
      <Message
        text={
          data.message ||
          errMessage(checkAll.error) ||
          errMessage(updateAll.error)
        }
      />
      <ActionStatus
        text={
          checkAll.isPending
            ? t("status.checkSources")
            : updateAll.isPending
              ? t("status.updateSources")
              : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3">
        <Button onClick={() => checkAll.mutate()} disabled={sourcesBusy}>
          {pendingLabel(
            checkAll.isPending,
            t("sources.checkAll"),
            t("common.checking")
          )}
        </Button>
        {data.totalUpdatable > 0 ? (
          <Button
            variant="primary"
            onClick={() => updateAll.mutate()}
            disabled={sourcesBusy}
          >
            <span className="[font-variant-numeric:tabular-nums]">
              {pendingLabel(
                updateAll.isPending,
                t("sources.updateAll", { count: data.totalUpdatable }),
                t("common.updating")
              )}
            </span>
          </Button>
        ) : null}
        <ViewModeToggle value={viewMode} onChange={setViewMode} />
      </div>
      <DiscoverSearch />
      <BusyRegion busy={sourcesBusy}>
        {data.sources.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--color-ink-2)] [text-wrap:pretty]">
            {t("sources.empty")}
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            {data.sources.map((src) => (
              <Link
                key={src.source}
                to="/external-sources/$source"
                params={{ source: src.source }}
                className="block overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)] transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-[0_12px_32px_oklch(20%_0.02_260/0.1)]"
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
                className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 transition-colors duration-200 hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
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
    </WorkbenchShell>
  );
}

export function ExternalSourceDetailPage({ source }: { source: string }) {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["external-source", source],
    queryFn: () => api.externalSource(source),
  });
  const allGlobalRef = useRef<HTMLInputElement>(null);

  const updateOne = useMutation({
    mutationFn: (skill: string) => api.updateSkill(skill),
    onSuccess: () => q.refetch(),
  });
  const updateAll = useMutation({
    mutationFn: () => api.updateAll(source),
    onSuccess: (data) => {
      if ("installed" in data)
        qc.setQueryData(["external-source", source], data);
    },
  });
  const remove = useMutation({
    mutationFn: (skill: string) => api.removeSkill(skill),
    onSuccess: async (data) => {
      qc.setQueryData(["external-sources"], data);
      // refetch を使うと失敗時にクエリが error 状態になり、一覧へ戻る前にエラー画面が一瞬出る。
      // 直接 API を叩いて反映することで、空になった source や失敗時も画面を飛ばさず一覧へ戻せる。
      try {
        const detail = await api.externalSource(source);
        if (detail.installed.length === 0) {
          navigate({ to: "/external-sources" });
        } else {
          qc.setQueryData(["external-source", source], detail);
        }
      } catch {
        navigate({ to: "/external-sources" });
      }
    },
  });
  const install = useMutation({
    mutationFn: (skills: string[]) => api.installExternal(source, skills, ""),
    onSuccess: () => q.refetch(),
  });
  const applyGlobal = useMutation({
    mutationFn: (states: Record<string, Tristate>) => api.apply(states),
    onMutate: async (states) => {
      await qc.cancelQueries({ queryKey: ["external-source", source] });
      const prev = qc.getQueryData<ExternalSourceDetailPayload>([
        "external-source",
        source,
      ]);
      if (prev) {
        qc.setQueryData<ExternalSourceDetailPayload>(
          ["external-source", source],
          {
            ...prev,
            message: "",
            installed: prev.installed.map((skill) =>
              skill.name in states
                ? {
                    ...skill,
                    state: states[skill.name]!,
                    hasUpdate:
                      states[skill.name] === "active" ? skill.hasUpdate : false,
                  }
                : skill
            ),
            updatable: prev.updatable.filter((name) => states[name] !== "off"),
          }
        );
      }
      return { prev };
    },
    onError: (_err, _states, ctx) => {
      if (ctx?.prev) qc.setQueryData(["external-source", source], ctx.prev);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["global"] });
      void qc.invalidateQueries({ queryKey: ["external-source", source] });
    },
  });

  const installed = q.data?.installed ?? [];
  const isGlobalOn = (skill: InstalledExternal) => skill.state === "active";
  const activeCount = installed.filter(isGlobalOn).length;
  const allActive = installed.length > 0 && activeCount === installed.length;
  const someActive = activeCount > 0 && !allActive;

  useEffect(() => {
    if (allGlobalRef.current) {
      allGlobalRef.current.indeterminate = someActive;
    }
  }, [someActive]);

  if (q.isPending) return <PageLoading variant="detail" />;
  if (q.isError) {
    return (
      <PageError
        current="external-sources"
        message={(q.error as Error).message}
      />
    );
  }
  const data = q.data;
  const detailBusy =
    updateAll.isPending ||
    updateOne.isPending ||
    remove.isPending ||
    install.isPending ||
    applyGlobal.isPending;

  const setGlobal = (name: string, on: boolean) => {
    applyGlobal.mutate({ [name]: on ? "active" : "off" });
  };

  const setAllGlobal = (on: boolean) => {
    if (!installed.length) return;
    const states: Record<string, Tristate> = {};
    if (on) {
      for (const skill of installed) {
        if (!isGlobalOn(skill)) states[skill.name] = "active";
      }
    } else {
      for (const skill of installed) {
        if (isGlobalOn(skill)) states[skill.name] = "off";
      }
    }
    if (Object.keys(states).length) applyGlobal.mutate(states);
  };

  return (
    <WorkbenchShell
      title={data.title}
      overline={`External · ${source}`}
      current="external-sources"
      decks={data.decks}
    >
      <Message text={data.message || errMessage(applyGlobal.error)} />
      <ActionStatus
        text={
          updateAll.isPending
            ? t("status.updateSource")
            : updateOne.isPending
              ? t("status.updateSkill")
              : remove.isPending
                ? t("status.removing")
                : install.isPending
                  ? t("status.installing")
                  : applyGlobal.isPending
                    ? t("status.applyingGlobal")
                    : undefined
        }
      />
      <OgpBanner source={source} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link
          to="/external-sources"
          className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm transition-[background,border-color] duration-100 ease-out hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
        >
          {t("detail.back")}
        </Link>
        {data.updatable.length ? (
          <Button
            variant="primary"
            disabled={detailBusy}
            onClick={() => updateAll.mutate()}
          >
            <span className="[font-variant-numeric:tabular-nums]">
              {pendingLabel(
                updateAll.isPending,
                t("detail.updateAll", { count: data.updatable.length }),
                t("common.updating")
              )}
            </span>
          </Button>
        ) : null}
      </div>
      {installed.length ? (
        <label className="mb-3 flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] px-3 py-2.5 text-sm">
          <input
            ref={allGlobalRef}
            type="checkbox"
            checked={allActive}
            disabled={detailBusy}
            onChange={(e) => setAllGlobal(e.target.checked)}
          />
          <span className="font-medium">{t("detail.allGlobalOn")}</span>
          <span className="text-[var(--color-ink-2)] [font-variant-numeric:tabular-nums]">
            ({activeCount}/{installed.length})
          </span>
        </label>
      ) : null}
      <BusyRegion busy={detailBusy} className="mb-4 grid gap-3">
        {installed.map((skill) => (
          <div
            key={skill.name}
            className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3"
          >
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
            <p className="m-0 mb-2 text-sm text-[var(--color-ink-2)]">
              {skill.description}
            </p>
            <div className="mb-2 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)]">
              {skill.path} · {skill.state}
            </div>
            {skill.hasUpdate ? (
              <div className="mb-2">
                <span className="text-xs text-[var(--color-warn)]">
                  {t("detail.hasUpdate")}
                </span>
                <div className="mt-2">
                  <Button
                    disabled={detailBusy}
                    onClick={() => updateOne.mutate(skill.name)}
                  >
                    {pendingLabel(
                      updateOne.isPending,
                      t("detail.updateOne"),
                      t("common.updating")
                    )}
                  </Button>
                </div>
              </div>
            ) : null}
            <Button
              disabled={detailBusy}
              onClick={async () => {
                const ok = await confirm({
                  title: t("detail.removeTitle", { name: skill.name }),
                  body: t("detail.removeConfirm"),
                  confirmLabel: t("detail.remove"),
                  tone: "danger",
                });
                if (ok) remove.mutate(skill.name);
              }}
            >
              {pendingLabel(
                remove.isPending,
                t("detail.remove"),
                t("common.processing")
              )}
            </Button>
          </div>
        ))}
      </BusyRegion>
      {data.available.length ? (
        <>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-ink-2)]">
            {t("detail.available")}
          </h2>
          <CheckboxList
            rows={data.available}
            submitLabel={t("detail.installSelected")}
            busy={install.isPending}
            onSubmit={(skills) => install.mutate(skills)}
          />
        </>
      ) : null}
    </WorkbenchShell>
  );
}

export function DraftsPage() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["drafts"], queryFn: () => api.drafts() });
  const run = useMutation({
    mutationFn: ({ action, skills }: { action: string; skills: string[] }) =>
      api.draftsAction(action, skills),
    onSuccess: (data) => qc.setQueryData(["drafts"], data),
    onError: (err) =>
      applyErrorBody(err, (body) => qc.setQueryData(["drafts"], body)),
  });

  if (q.isPending) return <PageLoading variant="list" />;
  if (q.isError) {
    return <PageError current="drafts" message={(q.error as Error).message} />;
  }
  const data = q.data;

  return (
    <WorkbenchShell
      title={data.title}
      overline={t("drafts.overline")}
      current="drafts"
      decks={data.decks}
      searchable
    >
      <Message text={data.message || errMessage(run.error)} />
      <ActionStatus text={run.isPending ? t("status.draftOp") : undefined} />
      <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 text-sm text-[var(--color-ink-2)] [text-wrap:pretty]">
        {t("drafts.help")}
      </div>
      {data.confirmSelected.length ? (
        <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3">
          <p className="m-0 mb-2 text-sm">{t("drafts.confirmOverwrite")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={run.isPending}
              onClick={() =>
                run.mutate({
                  action: "promote-force",
                  skills: data.confirmSelected,
                })
              }
            >
              {pendingLabel(
                run.isPending,
                t("drafts.promoteForce"),
                t("common.processing")
              )}
            </Button>
            <Button
              variant="primary"
              disabled={run.isPending}
              onClick={() =>
                run.mutate({
                  action: "install-force",
                  skills: data.confirmSelected,
                })
              }
            >
              {pendingLabel(
                run.isPending,
                t("drafts.installForce"),
                t("common.processing")
              )}
            </Button>
          </div>
        </div>
      ) : null}
      <SelectableSkills
        rows={data.rows}
        busy={run.isPending}
        actions={[
          {
            label: t("drafts.promote"),
            onClick: (skills) => run.mutate({ action: "promote", skills }),
          },
          {
            label: t("drafts.install"),
            primary: true,
            onClick: (skills) => run.mutate({ action: "install", skills }),
          },
        ]}
      />
    </WorkbenchShell>
  );
}

export function ProjectDeckPage({
  deckName,
  catalog,
}: {
  deckName: string;
  catalog: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const q = useQuery({
    queryKey: ["project-deck", deckName, catalog],
    queryFn: () => api.projectDeck(deckName, catalog),
  });

  const action = useMutation({
    mutationFn: ({ act, skills }: { act: string; skills: string[] }) =>
      api.projectDeckAction(deckName, act, skills),
    onSuccess: (data) =>
      qc.setQueryData(["project-deck", deckName, catalog], data),
  });

  const preview = useMutation({
    mutationFn: (source: string) => api.previewExternal(source, deckName),
    onSuccess: (data) => {
      qc.setQueryData(["external-preview", deckName, data.source], data);
      navigate({
        to: "/external-preview",
        search: { source: data.source, deck: deckName },
      });
    },
  });

  if (q.isPending) return <PageLoading variant="list" />;
  if (q.isError) {
    return (
      <PageError
        current={`project:${deckName}`}
        message={(q.error as Error).message}
      />
    );
  }
  const data = q.data;

  return (
    <WorkbenchShell
      title={data.title}
      overline={`Deck · ${deckName}`}
      current={`project:${deckName}`}
      decks={data.decks}
      searchable
    >
      <Message text={data.message || errMessage(action.error)} />
      <ActionStatus
        text={
          action.isPending
            ? t("status.deckApply")
            : preview.isPending
              ? t("status.fetchCandidates")
              : undefined
        }
      />
      {data.installCommands.length ? (
        <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]">
          <div className="mb-1 font-[family-name:var(--font-mono)] text-[10px] tracking-wide text-[var(--color-ink-2)]">
            INSTALLATION
          </div>
          <pre className="m-0 overflow-x-auto text-xs whitespace-pre-wrap">
            {data.installCommands.map((c) => `$ ${c}`).join("\n")}
          </pre>
          <Button
            className="mt-2"
            onClick={() => {
              navigator.clipboard
                ?.writeText(data.installCommands.join("\n"))
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            {copied ? t("deck.copied") : t("deck.copy")}
          </Button>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap gap-2">
        {catalog ? (
          <Link
            to="/project-decks/$deckName"
            params={{ deckName }}
            className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm transition-[background,border-color] duration-100 ease-out hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
          >
            {t("deck.showOnly")}
          </Link>
        ) : (
          <Link
            to="/project-decks/$deckName"
            params={{ deckName }}
            search={{ catalog: true }}
            className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--surface)] px-2.5 py-1.5 text-sm transition-[background,border-color] duration-100 ease-out hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]"
          >
            {t("global.addSkills")}
          </Link>
        )}
      </div>
      {catalog ? (
        <ExternalImportForm
          deck={deckName}
          onPreview={(s) => preview.mutate(s)}
          busy={preview.isPending}
        />
      ) : null}
      <SelectableSkills
        rows={data.rows}
        presetChecked
        busy={action.isPending}
        actions={
          catalog
            ? [
                {
                  label: t("deck.save"),
                  primary: true,
                  onClick: (skills) => action.mutate({ act: "save", skills }),
                },
              ]
            : [
                {
                  label: t("deck.apply"),
                  onClick: (skills) => action.mutate({ act: "apply", skills }),
                },
                {
                  label: t("deck.addGlobal"),
                  primary: true,
                  onClick: (skills) => action.mutate({ act: "merge", skills }),
                },
              ]
        }
      />
    </WorkbenchShell>
  );
}

export function SettingsPage() {
  const t = useT();
  const { settings, update } = useUiSettings();
  return (
    <WorkbenchShell
      title={t("settings.title")}
      overline={t("settings.overline")}
      sub={t("settings.sub")}
      current="settings"
    >
      <div className="grid max-w-[640px] gap-4">
        <section className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-4 shadow-[var(--shadow-lift)]">
          <h2 className="m-0 mb-1 text-sm font-semibold text-[var(--color-ink)]">
            {t("settings.language")}
          </h2>
          <p className="m-0 mb-3 text-xs text-[var(--color-ink-2)]">
            {t("settings.languageHelp")}
          </p>
          <SegmentedControl
            ariaLabel={t("settings.language")}
            value={settings.locale}
            onChange={(locale) => update({ locale })}
            options={[
              { value: "en", label: "English" },
              { value: "ja", label: "日本語" },
            ]}
          />
        </section>
        <section className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-4 shadow-[var(--shadow-lift)]">
          <h2 className="m-0 mb-1 text-sm font-semibold text-[var(--color-ink)]">
            {t("settings.viewDefault")}
          </h2>
          <p className="m-0 mb-3 text-xs text-[var(--color-ink-2)]">
            {t("settings.viewHelp")}
          </p>
          <SegmentedControl
            ariaLabel={t("settings.viewDefault")}
            value={settings.externalViewMode}
            onChange={(externalViewMode) => update({ externalViewMode })}
            options={[
              { value: "grid", label: t("view.grid"), icon: gridIcon },
              { value: "list", label: t("view.list"), icon: listIcon },
            ]}
          />
        </section>
      </div>
    </WorkbenchShell>
  );
}
