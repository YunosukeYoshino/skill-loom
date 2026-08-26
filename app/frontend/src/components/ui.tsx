import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "@/api/client";
import type { Counts } from "@shared/api-types";

/* ======================================================================
 * Workbench shell — A案「ワークベンチ」構造。
 * トップバー(brand・検索・counts) + 左ナビ(deck ツリー + Projection)
 * + 中央ステージ + 右ドロワー(更新・プリセット)。
 * モチーフは "loom": 経糸インジケータ・織りバー・十字テクスチャ。
 * ====================================================================== */

/** 織り機マーク: 経糸×緯糸と交点 */
export function LoomMark({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 19 19"
      fill="none"
      aria-hidden="true"
      className="text-[var(--color-accent)]"
    >
      <path
        d="M2 3.5h15M2 9.5h15M2 15.5h15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity=".38"
      />
      <path
        d="M5 1.5v16M9.5 1.5v16M14 1.5v16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity=".38"
      />
      <circle cx="9.5" cy="9.5" r="3.2" fill="var(--color-accent)" />
    </svg>
  );
}

/**
 * トップバーのグローバル検索。リスト側へ "loom:filter" CustomEvent を流し、
 * 表示中ページの TristateList / CheckboxList / SelectableSkills の絞り込みに接続する。
 */
function TopSearch() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const dispatch = (next: string) => {
    setValue(next);
    window.dispatchEvent(new CustomEvent("loom:filter", { detail: next }));
  };

  return (
    <label className="ml-1.5 flex min-w-0 max-w-[430px] flex-1 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[color-mix(in_oklab,var(--surface)_65%,transparent)] px-2.5 py-1.5 text-sm text-[var(--color-ink-2)] transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--color-accent)] focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
      <svg
        width="13"
        height="13"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="shrink-0 opacity-50"
      >
        <circle cx="6" cy="6" r="4.4" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M9.4 9.4L13 13"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => dispatch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            dispatch("");
            e.currentTarget.blur();
          }
        }}
        placeholder="スキルを検索…"
        className="w-full min-w-0 bg-transparent font-[family-name:inherit] tracking-inherit text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-2)] placeholder:opacity-75"
      />
      <kbd className="shrink-0 rounded-[5px] border border-[var(--color-rule)] border-b-2 bg-[var(--surface)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[9.5px] text-[var(--color-ink-2)]">
        ⌘K
      </kbd>
    </label>
  );
}

function Topbar({
  counts,
  searchable,
}: {
  counts?: Counts | null;
  searchable?: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-chrome-border)] bg-[var(--color-chrome)] backdrop-blur-[20px] backdrop-saturate-180">
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3.5 px-4 py-2 md:px-6">
        <div className="flex items-center gap-2.5">
          <LoomMark />
          <span className="font-[family-name:var(--font-display)] text-[1.06rem] font-semibold tracking-[-0.015em] [font-variation-settings:'opsz'_40]">
            Skill{" "}
            <em className="not-italic text-[var(--color-accent-text)]">Loom</em>
          </span>
          <span className="rounded-full border border-[var(--color-rule)] bg-[var(--surface)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[9.5px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase">
            manager
          </span>
        </div>
        {searchable ? <TopSearch /> : null}
        {counts ? (
          <div className="ml-auto flex items-baseline gap-3.5 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)] [font-variant-numeric:tabular-nums]">
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block size-1.5 rounded-full bg-[var(--color-accent)]" />
              active{" "}
              <b className="font-semibold text-[var(--color-ink)]">
                {counts.active}
              </b>
            </span>
            <span>off {counts.off}</span>
            <span className="max-sm:hidden">archive {counts.archive}</span>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** Projection の織りバー — Inventory から織り込まれた active/off/archive の糸 */
function ProjectionCard({ counts }: { counts: Counts }) {
  const total = Math.max(counts.total, 1);
  return (
    <div className="m-3 mt-3 border-t border-[var(--color-rule)] px-3 pt-3 pb-2.5">
      <p className="m-0 font-[family-name:var(--font-mono)] text-[9.5px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase">
        <b className="font-semibold text-[var(--color-accent-text)]">
          Projection
        </b>{" "}
        — agents
      </p>
      <p className="m-0 mt-1.5 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)] [font-variant-numeric:tabular-nums]">
        <b className="text-sm font-semibold text-[var(--color-accent-text)]">
          {counts.active}
        </b>{" "}
        active / {counts.off} off / {counts.archive} arch.
      </p>
      <div
        className="weave-bar mt-2"
        role="img"
        aria-label={`active ${counts.active} / off ${counts.off} / archive ${counts.archive}`}
      >
        <i
          className="weave-active"
          style={{ width: `${(counts.active / total) * 100}%` }}
        />
        <i
          className="weave-off"
          style={{ width: `${(counts.off / total) * 100}%` }}
        />
      </div>
      <p className="m-0 mt-1.5 text-[10.5px] leading-snug text-[var(--color-ink-2)]">
        Catalog {counts.total} から織り込まれた実行中の subset
      </p>
    </div>
  );
}

function SideNav({
  current,
  decks,
  counts,
}: {
  current: string;
  decks: string[];
  counts?: Counts | null;
}) {
  const [creating, setCreating] = useState(false);
  const deckList = decks ?? [];
  const items: { to: string; label: string; id: string }[] = [
    { to: "/global", label: "Global", id: "global" },
    { to: "/external-sources", label: "External", id: "external-sources" },
    { to: "/drafts", label: "Drafts", id: "drafts" },
  ];
  const linkClass = (active: boolean) =>
    `relative flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-sm font-medium transition-[background,color,padding-left] duration-100 ease-out ${
      active
        ? "bg-[var(--color-accent-soft)] pr-2.5 pl-[13px] font-semibold text-[var(--color-accent-text)]"
        : "text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]"
    }`;
  const isActive = (item: { id: string }) =>
    current === item.id || (item.id === "global" && current === "");

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-2.5 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-180 lg:sticky lg:top-[70px]">
      <nav
        className="flex flex-col gap-0.5 max-lg:flex-row max-lg:flex-wrap"
        aria-label="セクション"
      >
        {items.map((item) => (
          <Link
            key={item.id}
            to={item.to}
            className={`max-lg:flex-1 ${linkClass(isActive(item))}`}
          >
            {isActive(item) ? (
              <i
                aria-hidden
                className="absolute top-[20%] bottom-[20%] left-[3px] w-0.5 rounded-full bg-[var(--color-accent)]"
              />
            ) : null}
            <span className="mx-auto max-lg:inline">{item.label}</span>
          </Link>
        ))}
        <div className="pt-1 pb-0.5 pl-2.5 font-[family-name:var(--font-mono)] text-[9.5px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase max-lg:w-full max-lg:pt-3">
          Decks
        </div>
        {deckList.map((d) => {
          const active = current === `project:${d}`;
          return (
            <Link
              key={d}
              to="/project-decks/$deckName"
              params={{ deckName: d }}
              className={`max-lg:flex-1 ${linkClass(active)}`}
            >
              {active ? (
                <i
                  aria-hidden
                  className="absolute top-[20%] bottom-[20%] left-[3px] w-0.5 rounded-full bg-[var(--color-accent)]"
                />
              ) : null}
              <span className="max-lg:mx-auto">▸ {d}</span>
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={creating}
          aria-controls="create-deck-form"
          onClick={() => setCreating((open) => !open)}
          className="cursor-pointer rounded-[var(--radius-sm)] px-2.5 py-[7px] text-left text-sm font-medium text-[var(--color-ink-2)] transition-[background,color] duration-100 ease-out hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)] max-lg:flex-1 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="max-lg:mx-auto">+ Deck</span>
        </button>
      </nav>
      {creating ? <CreateDeckForm onClose={() => setCreating(false)} /> : null}
      {counts ? <ProjectionCard counts={counts} /> : null}
    </div>
  );
}

export type WorkbenchShellProps = {
  title: string;
  /** 見出し上の小さな一行 (例: "Catalog · projection") */
  overline?: string;
  /** 見出し下の補足 (例: "26 skills") */
  sub?: string;
  counts?: Counts | null;
  current: string;
  decks?: string[];
  /** 右ドロワーに置くパネル (更新・プリセット等)。狭い画面ではステージ下に回る。 */
  drawer?: ReactNode;
  /** トップバーにグローバル検索を出す (リスト絞り込みに接続) */
  searchable?: boolean;
  children: ReactNode;
};

export function WorkbenchShell({
  title,
  overline,
  sub,
  counts,
  current,
  decks,
  drawer,
  searchable,
  children,
}: WorkbenchShellProps) {
  return (
    <div className="min-h-screen">
      <Topbar counts={counts} searchable={searchable} />
      <div className="relative z-[1] mx-auto grid w-full max-w-[1480px] items-start gap-4 px-4 pt-4 pb-11 [grid-template-columns:minmax(0,1fr)] md:px-6 lg:[grid-template-columns:236px_minmax(0,1fr)] xl:[grid-template-columns:236px_minmax(0,1fr)_318px]">
        <SideNav current={current} decks={decks ?? []} counts={counts} />
        <main className="min-w-0">
          <div className="pb-3.5">
            {overline ? (
              <p className="m-0 flex items-center gap-2 font-[family-name:var(--font-mono)] text-[9.5px] font-medium tracking-[0.12em] text-[var(--color-ink-2)] uppercase">
                <i
                  aria-hidden
                  className="h-[1.5px] w-[18px] bg-[var(--color-accent)]"
                />
                {overline}
              </p>
            ) : null}
            <h1 className="m-0 mt-1.5 mb-1 font-[family-name:var(--font-display)] text-[clamp(1.55rem,2.4vw,1.95rem)] leading-[1.08] font-[540] tracking-[-0.02em] [font-variation-settings:'opsz'_60]">
              {title}
            </h1>
            {sub ? (
              <p className="m-0 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)] [font-variant-numeric:tabular-nums]">
                {sub}
              </p>
            ) : null}
          </div>
          {children}
        </main>
        {drawer ? (
          <aside className="grid min-w-0 items-start gap-3.5 max-xl:col-span-2 xl:sticky xl:top-[70px]">
            {drawer}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/* ======================================================================
 * 汎用部品 (既存 API を維持)
 * ====================================================================== */

type CreateDeckFormProps = {
  onClose: () => void;
};

/**
 * 空の Project Deck を作るフォーム。作成まわりの状態と API 呼び出しを
 * SideNav（汎用 UI の置き場）から切り離して持つ。
 */
export function CreateDeckForm({ onClose }: CreateDeckFormProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: (deckName: string) => api.createProjectDeck(deckName),
    onSuccess: (data) => {
      const deckName = data.deckName;
      setName("");
      setError("");
      qc.setQueryData(["project-deck", deckName, false], data);
      void qc.invalidateQueries();
      onClose();
      navigate({
        to: "/project-decks/$deckName",
        params: { deckName },
      });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    setError("");
    create.mutate(trimmed);
  };

  const close = () => {
    if (create.isPending) return;
    setName("");
    setError("");
    onClose();
  };

  return (
    <div
      id="create-deck-form"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-2 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-180"
    >
      <label
        htmlFor="new-deck-name"
        className="text-sm text-[var(--color-ink-2)]"
      >
        新しい Deck 名
      </label>
      <input
        id="new-deck-name"
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") close();
        }}
        disabled={create.isPending}
        placeholder="例: frontend"
        autoComplete="off"
        spellCheck={false}
        className="min-w-[160px] flex-1 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-sm outline-none transition-[border-color,box-shadow] duration-100 focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <Button
        variant="primary"
        disabled={create.isPending || !name.trim()}
        onClick={submit}
      >
        {pendingLabel(create.isPending, "作成", "作成中…")}
      </Button>
      <Button disabled={create.isPending} onClick={close}>
        キャンセル
      </Button>
      {error ? (
        <p className="m-0 basis-full text-sm text-[var(--color-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Message({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-accent-soft)] bg-[var(--color-accent-soft)] px-3.5 py-2.5 text-sm text-[var(--color-ink)]">
      {text}
    </div>
  );
}

export function pendingLabel(pending: boolean, idle: string, loading: string) {
  return pending ? loading : idle;
}

export function ActionStatus({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div
      className="mb-3 flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3.5 py-2.5 text-sm text-[var(--color-ink-2)]"
      role="status"
      aria-live="polite"
    >
      <span
        className="action-status-spinner inline-block size-3.5 shrink-0 rounded-full border-2 border-[var(--color-rule)] border-t-[var(--color-accent)]"
        aria-hidden
      />
      {text}
    </div>
  );
}

export function BusyRegion({
  busy,
  children,
  className = "",
}: {
  busy?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${className}${busy ? " opacity-60 transition-opacity duration-200 ease-out" : ""}`}
      aria-busy={busy || undefined}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
}) {
  const base =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm font-medium transition-[transform,background,border-color,opacity,box-shadow] duration-100 ease-out active:scale-[0.97] disabled:opacity-45";
  const styles =
    variant === "primary"
      ? "border-[var(--color-accent-hover)] bg-[linear-gradient(180deg,oklch(55%_0.17_255),var(--color-accent))] text-[var(--color-accent-ink)] shadow-[0_2px_6px_oklch(46%_0.165_255/0.35),inset_0_1px_0_oklch(100%_0_0/0.25)] hover:brightness-105"
      : "border-[var(--color-rule)] bg-[linear-gradient(180deg,oklch(100%_0_0),oklch(97.5%_0.006_255))] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(20%_0.02_260/0.05),inset_0_1px_0_oklch(100%_0_0/0.7)] hover:border-[var(--color-rule-strong)]";
  return (
    <button
      type="button"
      className={`${base} ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton-block ${className}`} aria-hidden />;
}

function LoadingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--color-chrome-border)] bg-[var(--color-chrome)] backdrop-blur-[20px] backdrop-saturate-180">
        <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3.5 px-4 py-2 md:px-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="ml-auto h-3.5 w-44" />
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-[1480px] items-start gap-4 px-4 pt-4 pb-11 [grid-template-columns:minmax(0,1fr)] md:px-6 lg:[grid-template-columns:236px_minmax(0,1fr)]">
        <nav
          aria-hidden
          className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-3 shadow-[var(--shadow-lift)]"
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full max-w-[160px]" />
          ))}
        </nav>
        <main>
          <div className="pb-3.5">
            <Skeleton className="mb-2 h-3 w-36" />
            <Skeleton className="h-9 w-2/5 max-w-xs" />
            <Skeleton className="mt-2 h-3 w-48" />
          </div>
          <div className="mb-3 flex flex-wrap gap-2 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-2.5 shadow-[var(--shadow-lift)]">
            <Skeleton className="h-9 min-w-[240px] flex-1 rounded-[var(--radius-sm)]" />
            <Skeleton className="h-9 w-20 rounded-[var(--radius-sm)]" />
            <Skeleton className="h-9 w-20 rounded-[var(--radius-sm)]" />
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

function LoadingListRows({ count = 6 }: { count?: number }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)]">
      <div className="divide-y divide-[var(--color-rule)]">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_12rem] items-center gap-x-3 px-3 py-3"
          >
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
            <Skeleton className="h-8 w-full justify-self-end rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingCardGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] shadow-[var(--shadow-lift)]"
        >
          <Skeleton className="aspect-[16/9] w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-5 w-3/5" />
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadingDetailBlocks({ count = 2 }: { count?: number }) {
  return (
    <div className="grid gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]"
        >
          <Skeleton className="mb-2 h-5 w-1/3" />
          <Skeleton className="mb-3 h-4 w-full max-w-lg" />
          <Skeleton className="mb-3 h-3 w-2/5" />
          <Skeleton className="h-8 w-24 rounded-[var(--radius-sm)]" />
        </div>
      ))}
    </div>
  );
}

export type PageLoadingVariant = "list" | "cards" | "detail";

export function PageLoading({
  variant = "list",
  label = "読み込み中",
}: {
  variant?: PageLoadingVariant;
  label?: string;
}) {
  return (
    <LoadingShell>
      <p className="sr-only" role="status" aria-live="polite">
        {label}
      </p>
      {variant === "cards" ? <LoadingCardGrid /> : null}
      {variant === "list" ? <LoadingListRows /> : null}
      {variant === "detail" ? <LoadingDetailBlocks /> : null}
    </LoadingShell>
  );
}

export function PageError({
  current,
  title = "読み込みに失敗しました",
  message,
  decks = [],
}: {
  current: string;
  title?: string;
  message: string;
  decks?: string[];
}) {
  return (
    <WorkbenchShell title={title} current={current} decks={decks}>
      <Message text={message} />
      <p className="m-0 text-sm text-[var(--color-ink-2)]">
        ナビから別の画面へ移動するか、ページを再読み込みしてください。開発時は
        Vite の内部ポートではなく、起動ログの公開 URL（Skill Loom
        UI）を開いているか確認してください。
      </p>
    </WorkbenchShell>
  );
}
