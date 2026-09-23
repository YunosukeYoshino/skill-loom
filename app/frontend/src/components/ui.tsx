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
import { useListViewSearch } from "@/router-search";
import { useT } from "@/settings/react";

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
 * useListViewSearch 経由で URL (?q=) にも反映され、リロードで復元される。
 */
function TopSearch() {
  const t = useT();
  const [urlSearch, setUrlSearch] = useListViewSearch();
  const [value, setValue] = useState(urlSearch.q ?? "");
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

  // リスト側の SearchField から dispatch された loom:filter にも追従し、
  // どちらの入力から変更しても表示が一致するようにする。
  useEffect(() => {
    const onFilter = (event: Event) => {
      setValue((event as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("loom:filter", onFilter);
    return () => window.removeEventListener("loom:filter", onFilter);
  }, []);

  const dispatch = (next: string) => {
    setValue(next);
    setUrlSearch({ q: next || undefined });
    window.dispatchEvent(new CustomEvent("loom:filter", { detail: next }));
  };

  return (
    <label className="ml-1.5 flex min-w-0 max-w-[430px] flex-1 max-md:hidden items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[color-mix(in_oklab,var(--surface)_65%,transparent)] px-2.5 py-1.5 text-sm text-[var(--color-ink-2)] transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--color-accent)] focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
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
        aria-label={t("search.aria")}
        value={value}
        onChange={(e) => dispatch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            dispatch("");
            e.currentTarget.blur();
          }
        }}
        placeholder={t("search.placeholder")}
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
  onMenu,
}: {
  counts?: Counts | null;
  searchable?: boolean;
  onMenu: () => void;
}) {
  const t = useT();
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-chrome-border)] bg-[var(--color-chrome)] backdrop-blur-[20px] backdrop-saturate-180">
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3.5 px-4 py-2 md:px-6">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label={t("nav.open")}
            aria-haspopup="dialog"
            onClick={onMenu}
            className="-ml-2 grid size-10 cursor-pointer place-items-center rounded-[var(--radius-sm)] text-[var(--color-ink-2)] transition-[background,color] duration-100 hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)] md:hidden"
          >
            <NavIcon id="menu" size={16} />
          </button>
          <LoomMark />
          <span className="font-[family-name:var(--font-display)] text-[1.06rem] font-semibold tracking-[-0.015em] [font-variation-settings:'opsz'_40]">
            Skill{" "}
            <em className="not-italic text-[var(--color-accent-text)]">Loom</em>
          </span>
          <span className="rounded-full border border-[var(--color-rule)] bg-[var(--surface)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[9.5px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase max-sm:hidden">
            manager
          </span>
        </div>
        {searchable ? <TopSearch /> : null}
        {counts ? (
          <div className="ml-auto flex items-baseline gap-3.5 font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-2)] [font-variant-numeric:tabular-nums]">
            <span className="inline-flex items-center gap-1.5">
              <i
                aria-hidden="true"
                className="inline-block size-1.5 rounded-full bg-[var(--color-accent)]"
              />
              active{" "}
              <b className="font-semibold text-[var(--color-ink)]">
                {counts.active}
              </b>
            </span>
            <span className="max-sm:hidden">off {counts.off}</span>
            <span className="max-sm:hidden">archive {counts.archive}</span>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** Projection の織りバー — Inventory から織り込まれた active/off/archive の糸 */
function ProjectionCard({ counts }: { counts: Counts }) {
  const t = useT();
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
        {t("projection.caption", { total: counts.total })}
      </p>
    </div>
  );
}

/** ナビ項目のアイコン — サイドナビ・タブレットのレール・モバイルのタブバーで共有 */
function NavIcon({ id, size = 14 }: { id: string; size?: number }) {
  const paths: Record<string, string> = {
    global:
      "M7 1.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 7 1.6ZM1.6 7h10.8M7 1.6c1.5 1.5 2.2 3.3 2.2 5.4S8.5 10.9 7 12.4C5.5 10.9 4.8 9.1 4.8 7S5.5 3.1 7 1.6Z",
    "external-sources":
      "M8.2 1.8h4v4M12.2 1.8 6.8 7.2M10.6 8.4v2.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1h2.8",
    drafts: "M9.4 2.2l2.4 2.4-7 7-3 .6.6-3 7-7ZM8.2 3.4l2.4 2.4",
    settings:
      "M7 4.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2ZM7 1.6v1.7M7 10.7v1.7M1.6 7h1.7M10.7 7h1.7M3.2 3.2l1.2 1.2M9.6 9.6l1.2 1.2M10.8 3.2L9.6 4.4M4.4 9.6l-1.2 1.2",
    menu: "M2 3.5h10M2 7h10M2 10.5h10",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className="shrink-0 opacity-75"
    >
      <path
        d={paths[id]}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PRIMARY_NAV = [
  { to: "/global", key: "nav.global", id: "global" },
  { to: "/external-sources", key: "nav.external", id: "external-sources" },
  { to: "/drafts", key: "nav.drafts", id: "drafts" },
] as const;

const isNavActive = (current: string, id: string) =>
  current === id || (id === "global" && current === "");

function SideNav({
  current,
  decks,
  counts,
}: {
  current: string;
  decks: string[];
  counts?: Counts | null;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const deckList = decks ?? [];
  const items = PRIMARY_NAV.map((item) => ({ ...item, label: t(item.key) }));
  const linkClass = (active: boolean) =>
    `relative flex min-h-10 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-sm font-medium transition-[background,color,padding-left] duration-100 ease-out ${
      active
        ? "bg-[var(--color-accent-soft)] pr-2.5 pl-[13px] font-semibold text-[var(--color-accent-text)]"
        : "text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]"
    }`;
  const isActive = (item: { id: string }) => isNavActive(current, item.id);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-2 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-180">
      <nav className="flex flex-col gap-0.5" aria-label={t("nav.aria")}>
        {items.map((item) => (
          <Link
            key={item.id}
            to={item.to}
            className={linkClass(isActive(item))}
          >
            {isActive(item) ? (
              <i
                aria-hidden
                className="absolute top-[20%] bottom-[20%] left-[3px] w-0.5 rounded-full bg-[var(--color-accent)]"
              />
            ) : null}
            <NavIcon id={item.id} />
            <span>{item.label}</span>
          </Link>
        ))}
        <div className="pt-1 pb-0.5 pl-2.5 font-[family-name:var(--font-mono)] text-[9.5px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase">
          {t("nav.decks")}
        </div>
        {deckList.map((d) => {
          const active = current === `project:${d}`;
          return (
            <Link
              key={d}
              to="/project-decks/$deckName"
              params={{ deckName: d }}
              className={linkClass(active)}
            >
              {active ? (
                <i
                  aria-hidden
                  className="absolute top-[20%] bottom-[20%] left-[3px] w-0.5 rounded-full bg-[var(--color-accent)]"
                />
              ) : null}
              <span>
                <span
                  aria-hidden
                  className="mr-1.5 text-[10px] leading-none text-[var(--color-ink-2)]"
                >
                  ▸
                </span>
                {d}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={creating}
          aria-controls="create-deck-form"
          onClick={() => setCreating((open) => !open)}
          className="flex min-h-10 cursor-pointer rounded-[var(--radius-sm)] px-2.5 py-[7px] text-left text-sm font-medium text-[var(--color-ink-2)] transition-[background,color] duration-100 ease-out hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span>{t("nav.newDeck")}</span>
        </button>
      </nav>
      {creating ? <CreateDeckForm onClose={() => setCreating(false)} /> : null}
      {counts ? <ProjectionCard counts={counts} /> : null}
      <div className="m-3 mt-1 border-t border-[var(--color-rule)] pt-2">
        <Link to="/settings" className={linkClass(current === "settings")}>
          {current === "settings" ? (
            <i
              aria-hidden
              className="absolute top-[20%] bottom-[20%] left-[3px] w-0.5 rounded-full bg-[var(--color-accent)]"
            />
          ) : null}
          <NavIcon id="settings" />
          <span>{t("nav.settings")}</span>
        </Link>
      </div>
    </div>
  );
}

/** タブレット (md–lg) のアイコンレール。deck 作成などの全項目はメニュー (ドロワー) から。 */
function RailNav({
  current,
  decks,
  onMenu,
}: {
  current: string;
  decks: string[];
  onMenu: () => void;
}) {
  const t = useT();
  const railClass = (active: boolean) =>
    `grid size-11 place-items-center rounded-[var(--radius-sm)] transition-[background,color] duration-100 ease-out ${
      active
        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]"
        : "text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]"
    }`;
  const rule = (
    <i aria-hidden className="my-1 h-px w-6 bg-[var(--color-rule)]" />
  );
  return (
    <nav
      aria-label={t("nav.aria")}
      className="flex flex-col items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-1.5 shadow-[var(--shadow-lift)] backdrop-blur-[20px] backdrop-saturate-180"
    >
      <button
        type="button"
        aria-label={t("nav.open")}
        aria-haspopup="dialog"
        title={t("nav.open")}
        onClick={onMenu}
        className={`cursor-pointer ${railClass(false)}`}
      >
        <NavIcon id="menu" size={16} />
      </button>
      {rule}
      {PRIMARY_NAV.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          aria-label={t(item.key)}
          title={t(item.key)}
          aria-current={isNavActive(current, item.id) ? "page" : undefined}
          className={railClass(isNavActive(current, item.id))}
        >
          <NavIcon id={item.id} size={16} />
        </Link>
      ))}
      {decks.length ? rule : null}
      {decks.map((d) => (
        <Link
          key={d}
          to="/project-decks/$deckName"
          params={{ deckName: d }}
          aria-label={d}
          title={d}
          aria-current={current === `project:${d}` ? "page" : undefined}
          className={`font-[family-name:var(--font-mono)] text-[10.5px] font-semibold uppercase ${railClass(current === `project:${d}`)}`}
        >
          {d.slice(0, 2)}
        </Link>
      ))}
      {rule}
      <Link
        to="/settings"
        aria-label={t("nav.settings")}
        title={t("nav.settings")}
        aria-current={current === "settings" ? "page" : undefined}
        className={railClass(current === "settings")}
      >
        <NavIcon id="settings" size={16} />
      </Link>
    </nav>
  );
}

/** モバイル (max-md) の下部タブバー */
function MobileTabBar({ current }: { current: string }) {
  const t = useT();
  const items = [
    ...PRIMARY_NAV,
    { to: "/settings", key: "nav.settings", id: "settings" },
  ] as const;
  return (
    <nav
      aria-label={t("nav.aria")}
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-[var(--color-rule)] bg-[var(--color-paper)] pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {items.map((item) => {
        const active = isNavActive(current, item.id);
        return (
          <Link
            key={item.id}
            to={item.to}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-colors duration-100 ${
              active
                ? "text-[var(--color-accent-text)]"
                : "text-[var(--color-ink-2)]"
            }`}
          >
            <NavIcon id={item.id} size={18} />
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}

/* ======================================================================
 * Modal — ネイティブ <dialog> (showModal) でフォーカストラップ・Esc・inert を
 * 任せる。狭い画面 (max-sm) の center はボトムシートになる。
 * ====================================================================== */

export function Modal({
  open,
  onClose,
  labelledBy,
  children,
  placement = "center",
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  /** center: 中央 (max-sm はボトムシート) / left: 左ドロワー (ナビ) */
  placement?: "center" | "left";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // ::backdrop のクリックは dialog 自身へのクリックとして届く
        if (e.target === e.currentTarget) onClose();
      }}
      className={`loom-dialog max-w-none border border-[var(--color-rule)] bg-[var(--surface)] p-0 text-[var(--color-ink)] shadow-[0_2px_4px_oklch(20%_0.02_260/0.06),0_24px_64px_oklch(20%_0.02_260/0.18)] ${
        placement === "left"
          ? "loom-drawer m-0 h-dvh max-h-none w-[min(300px,85vw)] rounded-r-[var(--radius-lg)] border-l-0"
          : "m-auto w-[min(520px,calc(100vw-2rem))] rounded-[var(--radius-lg)] max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none"
      }`}
    >
      {open ? children : null}
    </dialog>
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
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="min-h-screen">
      <a
        href="#stage"
        className="sr-only rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-3 py-2 text-[var(--color-accent-ink)] focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        {t("common.skipToContent")}
      </a>
      <Topbar
        counts={counts}
        searchable={searchable}
        onMenu={() => setNavOpen(true)}
      />
      <div className="relative z-[1] mx-auto grid w-full max-w-[1480px] items-start gap-4 px-4 pt-4 pb-11 [grid-template-columns:minmax(0,1fr)] max-md:pb-32 md:px-6 md:[grid-template-columns:60px_minmax(0,1fr)] lg:[grid-template-columns:236px_minmax(0,1fr)] xl:[grid-template-columns:236px_minmax(0,1fr)_318px]">
        <div className="sticky top-[70px] max-md:hidden">
          <div className="lg:hidden">
            <RailNav
              current={current}
              decks={decks ?? []}
              onMenu={() => setNavOpen(true)}
            />
          </div>
          <div className="max-lg:hidden">
            <SideNav current={current} decks={decks ?? []} counts={counts} />
          </div>
        </div>
        <main id="stage" className="min-w-0 [scroll-margin-top:5rem]">
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
            <h1 className="m-0 mt-1.5 mb-1 font-[family-name:var(--font-display)] text-[clamp(1.55rem,2.4vw,1.95rem)] leading-[1.08] font-[540] tracking-[-0.02em] [font-variation-settings:'opsz'_60] [text-wrap:balance]">
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
          <aside className="grid min-w-0 items-start gap-3.5 md:max-xl:col-start-2 md:max-xl:grid-cols-2 xl:sticky xl:top-[70px]">
            {drawer}
          </aside>
        ) : null}
      </div>
      <MobileTabBar current={current} />
      <Modal
        open={navOpen}
        onClose={() => setNavOpen(false)}
        labelledBy="nav-drawer-title"
        placement="left"
      >
        <div
          className="p-2"
          onClickCapture={(e) => {
            // ナビ先へ移動したらドロワーを閉じる
            if ((e.target as HTMLElement).closest("a")) setNavOpen(false);
          }}
        >
          <h2 id="nav-drawer-title" className="sr-only">
            {t("nav.aria")}
          </h2>
          <SideNav current={current} decks={decks ?? []} counts={counts} />
        </div>
      </Modal>
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
  const t = useT();
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
        {t("deckForm.label")}
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
        placeholder={t("deckForm.placeholder")}
        autoComplete="off"
        spellCheck={false}
        className="min-w-[160px] flex-1 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-sm outline-none transition-[border-color,box-shadow] duration-100 focus:border-[var(--color-focus)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <Button
        variant="primary"
        disabled={create.isPending || !name.trim()}
        onClick={submit}
      >
        {pendingLabel(
          create.isPending,
          t("common.create"),
          t("common.creating")
        )}
      </Button>
      <Button disabled={create.isPending} onClick={close}>
        {t("common.cancel")}
      </Button>
      {error ? (
        <p className="m-0 basis-full text-sm text-[var(--color-ink)] [text-wrap:pretty]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Message({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div
      className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-accent-soft)] bg-[var(--color-accent-soft)] px-3.5 py-2.5 text-sm text-[var(--color-ink)] [text-wrap:pretty]"
      role="status"
      aria-live="polite"
    >
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

/**
 * 操作結果のトースト — ink 面・右下 (max-sm は下端いっぱい)・自動で消える。
 * action は「直前に戻す」等の取り消し導線。
 */
export function Toast({
  text,
  action,
  onDismiss,
}: {
  text?: string;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
}) {
  const t = useT();
  useEffect(() => {
    if (!text) return;
    const timer = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(timer);
  }, [text, onDismiss]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 max-w-[min(420px,calc(100vw-2rem))] max-sm:right-3 max-sm:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-sm:left-3 max-sm:max-w-none"
    >
      {text ? (
        <div className="toast-enter pointer-events-auto flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-ink)] py-2 pr-2 pl-4 text-sm text-[var(--color-paper)] shadow-[0_2px_4px_oklch(20%_0.02_260/0.06),0_24px_64px_oklch(20%_0.02_260/0.22)]">
          <span className="min-w-0 flex-1 py-1 [text-wrap:pretty]">{text}</span>
          {action ? (
            <button
              type="button"
              onClick={() => {
                action.onClick();
                onDismiss();
              }}
              className="min-h-9 shrink-0 cursor-pointer rounded-[var(--radius-sm)] px-2 font-semibold text-[oklch(80%_0.1_255)] transition-[background] duration-100 hover:bg-[oklch(100%_0_0/0.08)]"
            >
              {action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("toast.dismiss")}
            onClick={onDismiss}
            className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-sm)] text-[oklch(100%_0_0/0.6)] transition-[background,color] duration-100 hover:bg-[oklch(100%_0_0/0.08)] hover:text-[var(--color-paper)]"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ) : null}
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
  variant?: "primary" | "secondary" | "danger";
}) {
  const base =
    "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm font-medium transition-[transform,background,border-color,opacity,box-shadow] duration-100 ease-out active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45";
  const styles = {
    primary:
      "border-[var(--color-ink)] [background:var(--btn-primary-face)] text-[var(--color-paper)] shadow-[var(--btn-primary-edge)] hover:brightness-125",
    secondary:
      "border-[var(--color-rule)] [background:var(--btn-secondary-face)] text-[var(--color-ink)] shadow-[var(--btn-secondary-edge)] hover:border-[var(--color-rule-strong)]",
    // 破壊的操作。warn (明) は白文字のコントラストが足りないので warn-text を面に使う
    danger:
      "border-transparent [background:var(--color-warn-text)] text-white hover:brightness-110",
  }[variant];
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
          className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-chrome-border)] bg-[var(--color-chrome)] p-3 shadow-[var(--shadow-lift)] max-lg:hidden"
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
  label,
}: {
  variant?: PageLoadingVariant;
  label?: string;
}) {
  const t = useT();
  return (
    <LoadingShell>
      <p className="sr-only" role="status" aria-live="polite">
        {label ?? t("common.loading")}
      </p>
      {variant === "cards" ? <LoadingCardGrid /> : null}
      {variant === "list" ? <LoadingListRows /> : null}
      {variant === "detail" ? <LoadingDetailBlocks /> : null}
    </LoadingShell>
  );
}

export function PageError({
  current,
  title,
  message,
  decks = [],
}: {
  current: string;
  title?: string;
  message: string;
  decks?: string[];
}) {
  const t = useT();
  return (
    <WorkbenchShell
      title={title ?? t("error.title")}
      current={current}
      decks={decks}
    >
      <Message text={message} />
      <p className="m-0 text-sm text-[var(--color-ink-2)]">{t("error.hint")}</p>
    </WorkbenchShell>
  );
}
