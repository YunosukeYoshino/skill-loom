import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from "@/settings/react";
import { Button } from "./ui";

/* ======================================================================
 * Modal / ConfirmDialog — ネイティブ <dialog> (showModal) でフォーカス
 * トラップ・Esc・inert を任せる。狭い画面 (max-sm) ではボトムシートになる。
 * ====================================================================== */

export function Modal({
  open,
  onClose,
  labelledBy,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  className?: string;
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
      className={`loom-dialog m-auto w-[min(520px,calc(100vw-2rem))] max-w-none rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-0 text-[var(--color-ink)] shadow-[0_2px_4px_oklch(20%_0.02_260/0.06),0_24px_64px_oklch(20%_0.02_260/0.18)] max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none ${className}`}
    >
      {open ? children : null}
    </dialog>
  );
}

export type ConfirmDetail = { label: string; value: ReactNode };

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** 何が・いくつ・どう戻せるか を key/value で示す */
  details?: ConfirmDetail[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<
  ((options: ConfirmOptions) => Promise<boolean>) | null
>(null);

/** window.confirm() の置き換え。`if (!(await confirm({...}))) return;` で使う。 */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm outside ConfirmProvider");
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    []
  );

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => settle(false)}
        labelledBy="confirm-dialog-title"
      >
        {pending ? (
          <ConfirmBody
            options={pending}
            onCancel={() => settle(false)}
            onConfirm={() => settle(true)}
          />
        ) : null}
      </Modal>
    </ConfirmContext.Provider>
  );
}

/** ダイアログ共通の骨格: (アイコン) 見出し・本文 + 右寄せフッタ。max-sm ではフッタを縦積み。 */
export function DialogFrame({
  titleId,
  title,
  icon,
  children,
  footer,
}: {
  titleId: string;
  title: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div>
      <div className="flex gap-3.5 px-5 pt-5 pb-4">
        {icon}
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="m-0 font-[family-name:var(--font-display)] text-[1.15rem] leading-snug font-[540] tracking-[-0.015em] [text-wrap:balance]"
          >
            {title}
          </h2>
          {children}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--color-rule)] bg-[var(--color-paper)] px-5 py-3 max-sm:flex-col-reverse max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:[&>button]:justify-center">
        {footer}
      </div>
    </div>
  );
}

/** 何が・いくつ・どう戻せるか を並べる key/value ボックス */
export function DetailBox({ details }: { details: ConfirmDetail[] }) {
  return (
    <dl className="m-0 mt-3.5 divide-y divide-[var(--color-rule)] rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] px-3 text-sm">
      {details.map((d) => (
        <div
          key={d.label}
          className="flex items-baseline justify-between gap-3 py-2"
        >
          <dt className="shrink-0 font-[family-name:var(--font-mono)] text-[10px] font-medium tracking-[0.09em] text-[var(--color-ink-2)] uppercase">
            {d.label}
          </dt>
          <dd className="m-0 min-w-0 text-right font-[family-name:var(--font-mono)] text-xs break-words [font-variant-numeric:tabular-nums]">
            {d.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ConfirmBody({
  options,
  onCancel,
  onConfirm,
}: {
  options: ConfirmOptions;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const danger = options.tone === "danger";
  return (
    <DialogFrame
      titleId="confirm-dialog-title"
      title={options.title}
      icon={
        <span
          aria-hidden
          className={`grid size-9 shrink-0 place-items-center rounded-full ${
            danger
              ? "bg-[var(--color-warn-soft)] text-[var(--color-warn-text)]"
              : "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            {danger ? (
              <path
                d="M8 5.5v3.2M8 11.2v.1M7.1 2.4 1.6 12a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.4a1 1 0 0 0-1.8 0Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M8 7.2v4M8 4.8v.1M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            )}
          </svg>
        </span>
      }
      footer={
        <>
          <Button onClick={onCancel}>
            {options.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            autoFocus={!danger}
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {options.confirmLabel}
          </Button>
        </>
      }
    >
      {options.body ? (
        <p className="m-0 mt-1.5 text-sm text-[var(--color-ink-2)] [text-wrap:pretty]">
          {options.body}
        </p>
      ) : null}
      {options.details?.length ? <DetailBox details={options.details} /> : null}
    </DialogFrame>
  );
}
