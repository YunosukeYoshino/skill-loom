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

type MastheadProps = {
  title: string;
  counts?: {
    active: number;
    off: number;
    archive: number;
    total: number;
  } | null;
};

export function Masthead({ title, counts }: MastheadProps) {
  return (
    <header className="mb-4 grid gap-2 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-4 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
      <div className="flex items-center gap-2">
        <span className="font-[family-name:var(--font-display)] text-[0.95rem] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
          Skill Loom
        </span>
        <span className="h-3.5 w-px bg-[var(--color-rule)]" aria-hidden />
        <p className="m-0 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.04em] text-[var(--color-accent)] uppercase">
          manager
        </p>
      </div>
      <div>
        <h1 className="m-0 mb-1 font-[family-name:var(--font-display)] text-[clamp(1.6rem,2.6vw,2.1rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-[var(--color-ink)]">
          {title}
        </h1>
        {counts ? (
          <div className="flex flex-wrap gap-3 font-[family-name:var(--font-mono)] text-xs tracking-[0.01em] text-[var(--color-ink-2)]">
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block size-1.5 rounded-full bg-[var(--color-accent)]" />
              active {counts.active}
            </span>
            <span>off {counts.off}</span>
            <span>archive {counts.archive}</span>
            <span>total {counts.total}</span>
          </div>
        ) : null}
      </div>
    </header>
  );
}

type NavProps = {
  current: string;
  decks: string[];
};

export function Nav({ current, decks }: NavProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const deckList = decks ?? [];
  const items: { to: string; label: string; id: string }[] = [
    { to: "/global", label: "Global", id: "global" },
    { to: "/external-sources", label: "External", id: "external-sources" },
    { to: "/drafts", label: "Drafts", id: "drafts" },
    ...deckList.map((d) => ({
      to: `/project-decks/${d}`,
      label: d,
      id: `project:${d}`,
    })),
  ];

  const create = useMutation({
    mutationFn: (deckName: string) => api.createProjectDeck(deckName),
    onSuccess: (data) => {
      const deckName = data.deckName;
      setCreating(false);
      setName("");
      setError("");
      qc.setQueryData(["project-deck", deckName, false], data);
      void qc.invalidateQueries();
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
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    setError("");
    create.mutate(trimmed);
  };

  const close = () => {
    if (create.isPending) return;
    setCreating(false);
    setName("");
    setError("");
  };

  return (
    <div className="mb-4">
      <nav className="flex flex-wrap gap-1 rounded-[var(--radius-md)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-1 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
        <span className="ml-1.5 self-center font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.04em] text-[var(--color-ink-2)] uppercase">
          nav
        </span>
        {items.map((item) => {
          const active =
            current === item.id || (item.id === "global" && current === "");
          return (
            <Link
              key={item.id}
              to={item.to}
              className={
                active
                  ? "rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-accent-ink)] transition-[transform,opacity] duration-100 ease-out active:scale-[0.97]"
                  : "rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-2)] transition-[transform,background,color] duration-100 ease-out hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)] active:scale-[0.97]"
              }
            >
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={creating}
          aria-controls="create-deck-form"
          disabled={create.isPending}
          onClick={() => (creating ? close() : setCreating(true))}
          className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-2)] transition-[transform,background,color] duration-100 ease-out hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Deck
        </button>
      </nav>
      {creating ? (
        <div
          id="create-deck-form"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-2 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150"
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
    "cursor-pointer rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm font-medium transition-[transform,background,border-color,opacity] duration-100 ease-out active:scale-[0.97] disabled:opacity-45";
  const styles =
    variant === "primary"
      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]"
      : "border-[var(--color-rule)] bg-[var(--surface)] text-[var(--color-ink)] hover:border-[var(--color-rule-strong)] hover:bg-[var(--color-paper-2)]";
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

function LoadingMasthead({ withCounts = false }: { withCounts?: boolean }) {
  return (
    <header className="mb-4 grid gap-2 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-4 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-20" />
        <span className="h-3.5 w-px bg-[var(--color-rule)]" aria-hidden />
        <Skeleton className="h-3 w-14" />
      </div>
      <div>
        <Skeleton className="mb-2 h-8 w-2/5 max-w-xs" />
        {withCounts ? (
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
        ) : (
          <Skeleton className="h-3 w-48 max-w-full" />
        )}
      </div>
    </header>
  );
}

function LoadingNav() {
  return (
    <nav
      className="mb-4 flex flex-wrap gap-1 rounded-[var(--radius-md)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-1 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-150"
      aria-hidden
    >
      <Skeleton className="mx-1.5 my-1.5 h-3 w-6" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-16 rounded-[var(--radius-sm)]" />
      ))}
    </nav>
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
  withCounts = false,
  label = "読み込み中",
}: {
  variant?: PageLoadingVariant;
  withCounts?: boolean;
  label?: string;
}) {
  return (
    <Shell>
      <p className="sr-only" role="status" aria-live="polite">
        {label}
      </p>
      <LoadingMasthead withCounts={withCounts} />
      <LoadingNav />
      <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lift)]">
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 min-w-[240px] flex-1 rounded-[var(--radius-sm)]" />
          <Skeleton className="h-9 w-16 rounded-[var(--radius-sm)]" />
        </div>
      </div>
      {variant === "cards" ? <LoadingCardGrid /> : null}
      {variant === "list" ? <LoadingListRows /> : null}
      {variant === "detail" ? <LoadingDetailBlocks /> : null}
    </Shell>
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
    <Shell>
      <Masthead title={title} />
      <Nav current={current} decks={decks} />
      <Message text={message} />
      <p className="m-0 text-sm text-[var(--color-ink-2)]">
        ナビから別の画面へ移動するか、ページを再読み込みしてください。開発時は
        Vite の内部ポートではなく、起動ログの公開 URL（Skill Loom
        UI）を開いているか確認してください。
      </p>
    </Shell>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-[1080px] px-4 py-5 pb-14">{children}</main>
  );
}
