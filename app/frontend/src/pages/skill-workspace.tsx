import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import type {
  SkillCodexState,
  SkillRef,
  SkillVersion,
  SkillView,
  SkillUpstreamStatus,
} from "@shared/skill-workspace-types";
import {
  skillWorkspaceApi as api,
  type SkillAction,
} from "@/api/skill-workspace";
import { useConfirm } from "@/components/dialog";
import { Button, Message, WorkbenchShell } from "@/components/ui";
import { useT, useUiSettings } from "@/settings/react";

const panel =
  "rounded-[var(--radius-lg)] border border-[var(--color-rule)] bg-[var(--surface)] p-3";
const field =
  "w-full rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-2 text-sm disabled:opacity-60";
const code =
  "m-0 overflow-auto whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-xs leading-relaxed";

function SafeMarkdown({ html, failure }: { html: string; failure: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let cancelled = false;
    container.replaceChildren();
    setError(false);
    // 同じ許可リストを使い、未信頼のHTMLを再パースせずDOMへ挿入する。
    const elements = [
      "div",
      "span",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "a",
      "strong",
      "b",
      "em",
      "i",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "blockquote",
      "br",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "del",
      "details",
      "summary",
    ];
    const attributes = ["href", "title", "colspan", "rowspan", "start"];
    async function render() {
      if (!container) return;
      if ("setHTML" in container && typeof container.setHTML === "function") {
        (
          container as HTMLDivElement & {
            setHTML: (html: string, options: object) => void;
          }
        ).setHTML(html, { sanitizer: { elements, attributes } });
      } else {
        const { default: DOMPurify } = await import("dompurify");
        if (cancelled) return;
        container.replaceChildren(
          DOMPurify.sanitize(html, {
            ALLOWED_TAGS: [...elements, "#text"],
            ALLOWED_ATTR: attributes,
            ALLOW_ARIA_ATTR: false,
            ALLOW_DATA_ATTR: false,
            KEEP_CONTENT: false,
            RETURN_DOM_FRAGMENT: true,
          })
        );
      }
    }
    void render().catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [html]);
  return (
    <>
      {error ? <Message text={failure} /> : null}
      <div
        ref={ref}
        className="break-words text-sm leading-relaxed [&_a]:text-[var(--color-accent)] [&_a]:underline [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_p]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-[var(--color-paper-2)] [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-rule)] [&_blockquote]:pl-3 [&_table]:block [&_table]:overflow-auto [&_th]:border [&_td]:border [&_th]:p-2 [&_td]:p-2"
      />
    </>
  );
}

function isActive(state?: SkillCodexState) {
  return !!state && ["starting", "running", "approval"].includes(state.status);
}

type Editor = {
  path: string;
  content: string;
  original: string;
  revision: string;
};

type Localize = (ja: string, en: string) => string;
type ViewMode = "markdown" | "source" | "diff" | "editor";
type CodexOperation =
  | { action: "start"; prompt: string }
  | { action: "interrupt" }
  | {
      action: "approve";
      id: string | number;
      decision: "accept" | "decline";
    };

function CodexConversation({
  state,
  queryError,
  actionError,
  fetching,
  busy,
  workDisabled,
  reconnectDisabled,
  prompt,
  onPromptChange,
  onClose,
  onAction,
  onReconnect,
  l,
}: {
  state?: SkillCodexState;
  queryError: Error | null;
  actionError: Error | null;
  fetching: boolean;
  busy: boolean;
  workDisabled: boolean;
  reconnectDisabled: boolean;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onClose: () => void;
  onAction: (operation: CodexOperation) => void;
  onReconnect: () => void;
  l: Localize;
}) {
  const t = useT();
  const active = isActive(state);
  const sendDisabled = workDisabled || !prompt.trim();
  const error = state?.error || queryError?.message || actionError?.message;
  const failed = !!(state?.error || queryError || actionError);
  return (
    <section
      className={panel}
      aria-label={l("Codex の会話", "Codex conversation")}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">Codex</h2>
        <Button onClick={onClose}>{l("閉じる", "Close")}</Button>
      </div>
      <p role="status" className="text-xs text-[var(--color-ink-2)]">
        {state?.status ??
          (fetching ? t("common.loading") : l("未接続", "Not connected"))}
      </p>
      <Message text={error} />
      {failed ? (
        <p className="text-xs">
          {l(
            "ログインが必要な場合はローカルで codex login を実行して再試行してください。手動編集は引き続き使えます。",
            "If sign-in is required, run codex login locally and retry. Manual editing remains available."
          )}
        </p>
      ) : null}
      <ConversationHistory state={state} l={l} />
      {state?.approvals.map((approval) => (
        <div
          key={approval.id}
          className="my-3 rounded border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-2"
        >
          <h3 className="m-0 text-sm font-semibold">{approval.title}</h3>
          <pre className={`${code} my-2 max-h-64`}>{approval.detail}</pre>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                onAction({
                  action: "approve",
                  id: approval.id,
                  decision: "accept",
                })
              }
            >
              {l("許可", "Allow")}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                onAction({
                  action: "approve",
                  id: approval.id,
                  decision: "decline",
                })
              }
            >
              {l("拒否", "Decline")}
            </Button>
          </div>
        </div>
      ))}
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (sendDisabled) return;
          onAction({ action: "start", prompt: prompt.trim() });
        }}
      >
        <label htmlFor="skill-codex-prompt" className="text-sm">
          {l("編集の依頼・エラー内容", "Editing request / error details")}
        </label>
        <textarea
          id="skill-codex-prompt"
          className={field}
          rows={5}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          disabled={active || busy}
        />
        <p className="m-0 text-xs text-[var(--color-ink-2)]">
          {l(
            "作業用コピーだけを編集します。利用中の版への適用は別操作です。",
            "Edits only the working copy. Applying to the installed version is a separate step."
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={sendDisabled}>
            {l("Codex に依頼", "Send to Codex")}
          </Button>
          <Button
            disabled={!active || busy}
            onClick={() => onAction({ action: "interrupt" })}
          >
            {l("停止", "Stop")}
          </Button>
          <Button disabled={reconnectDisabled} onClick={onReconnect}>
            {l("再接続", "Reconnect")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function UpstreamTracking({
  upstream,
  disabled,
  hasWork,
  onCheck,
  onMerge,
  l,
}: {
  upstream: SkillUpstreamStatus;
  disabled: boolean;
  hasWork: boolean;
  onCheck: () => void;
  onMerge: () => void;
  l: Localize;
}) {
  const upstreamLabels = {
    unchecked: l("上流は未確認", "Upstream not checked"),
    current: l("上流と同期済み", "Up to date"),
    behind: l("上流に更新あり", "Upstream updates available"),
    missing: l("上流で見つかりません", "Not found upstream"),
    unavailable: l("上流を確認できません", "Cannot check upstream"),
    review: l("要確認", "Needs review"),
    unknown: l("基準版不明", "Unknown baseline"),
  };
  const upstreamBlocked =
    upstream && ["missing", "unavailable", "review"].includes(upstream.state);
  const formatCommit = (value?: { commit: string; date: string }) =>
    value
      ? `${value.commit.slice(0, 8)} · ${value.date}`
      : l("不明", "Unknown");

  return (
    <section
      className={`${panel} mb-3 text-xs ${upstreamBlocked ? "bg-[var(--color-paper-2)] text-[var(--color-ink-2)]" : ""}`}
      aria-label={l("上流の追跡", "Upstream tracking")}
    >
      <p className="m-0 mb-2 font-semibold">{upstreamLabels[upstream.state]}</p>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
        <dt>{l("基準版", "Baseline")}</dt>
        <dd className="m-0">{formatCommit(upstream.baseline)}</dd>
        <dt>{l("上流最新版", "Latest upstream")}</dt>
        <dd className="m-0">{formatCommit(upstream.latest)}</dd>
        <dt>{l("未取り込み", "Commits behind")}</dt>
        <dd className="m-0">
          {upstream.baseline &&
          ["current", "behind"].includes(upstream.state) &&
          upstream.behind !== null
            ? upstream.behind
            : l("不明", "Unknown")}
        </dd>
        <dt>{l("最終確認成功", "Last successful check")}</dt>
        <dd className="m-0">
          {upstream.checkedAt ?? l("未確認", "Not checked")}
        </dd>
        {upstream.attemptedAt && upstream.attemptedAt !== upstream.checkedAt ? (
          <>
            <dt>{l("最終確認の試行", "Last check attempt")}</dt>
            <dd className="m-0">{upstream.attemptedAt}</dd>
          </>
        ) : null}
      </dl>
      {upstream.message ? <p>{upstream.message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={onCheck}>
          {l("更新を確認", "Check upstream")}
        </Button>
        <Button
          disabled={
            disabled ||
            !hasWork ||
            !!upstreamBlocked ||
            !upstream.latest ||
            upstream.state === "current"
          }
          onClick={onMerge}
        >
          {l("最新版を作業へ取り込む", "Merge latest into work")}
        </Button>
      </div>
    </section>
  );
}

function WorkspaceIssues({
  workspace,
  locked,
  unsaved,
  version,
  onReconcile,
  onResolve,
  l,
}: {
  workspace?: SkillView["workspace"];
  locked: boolean;
  unsaved: boolean;
  version: SkillVersion;
  onReconcile: () => void;
  onResolve: (path: string, choice: "work" | "upstream") => void;
  l: Localize;
}) {
  const disabled = locked || unsaved || version !== "work";
  return (
    <>
      {" "}
      {workspace?.baseChanged ? (
        <>
          <Message
            text={l(
              "正本が別の操作で変わりました。差分を比較して調整してください。適用は停止しています。",
              "The source changed elsewhere. Compare and reconcile the changes. Apply is blocked."
            )}
          />
          <Button className="mb-3" disabled={disabled} onClick={onReconcile}>
            {l("正本の変更を作業版へ取り込む", "Reconcile source into work")}
          </Button>
        </>
      ) : null}
      {workspace?.issues.length || workspace?.conflicts.length ? (
        <div className={`${panel} mb-3`} role="alert">
          <h2 className="m-0 mb-2 text-sm font-semibold">
            {l("検証・競合の問題", "Validation issues / conflicts")}
          </h2>
          <ul className="m-0 list-disc pl-5 text-sm">
            {workspace.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          {workspace.conflicts.map((path) => (
            <div
              key={path}
              className="mt-2 flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="break-all font-[family-name:var(--font-mono)]">
                {path}
              </span>
              {(["work", "upstream"] as const).map((choice) => (
                <Button
                  key={choice}
                  disabled={disabled}
                  onClick={() => onResolve(path, choice)}
                >
                  {choice === "work"
                    ? l("作業版を残す", "Keep work")
                    : l("上流版を使う", "Use upstream")}
                </Button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function FileList({
  files,
  selectedFile,
  busy,
  onSelect,
  l,
}: {
  files: SkillView["files"];
  selectedFile: string;
  busy: boolean;
  onSelect: (path: string) => void;
  l: Localize;
}) {
  return (
    <aside className={panel} aria-label={l("ファイル一覧", "Files")}>
      <h2 className="m-0 mb-2 text-sm font-semibold">
        {l("ファイル", "Files")}
      </h2>
      <ul className="m-0 max-h-[65vh] list-none overflow-auto p-0">
        {files.map((item) => (
          <li key={item.path}>
            <button
              type="button"
              disabled={busy}
              aria-current={item.path === selectedFile ? "true" : undefined}
              className={`w-full cursor-pointer rounded px-2 py-2 text-left text-xs break-all hover:bg-[var(--color-paper-2)] ${item.path === selectedFile ? "bg-[var(--color-accent-soft)] font-semibold" : ""}`}
              onClick={() => onSelect(item.path)}
            >
              {item.path}
              <span className="mt-1 block font-normal text-[var(--color-ink-2)]">
                {item.size.toLocaleString()} B ·{" "}
                {item.binary ? l("バイナリ", "Binary") : l("テキスト", "Text")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function FileEditor({
  editor,
  locked,
  unsaved,
  onChange,
  onSave,
  l,
}: {
  editor: Editor;
  locked: boolean;
  unsaved: boolean;
  onChange: (editor: Editor) => void;
  onSave: () => void;
  l: Localize;
}) {
  const t = useT();
  return (
    <>
      <label htmlFor="skill-editor" className="sr-only">
        {l("ファイルを編集", "Edit file")} {editor.path}
      </label>
      <textarea
        id="skill-editor"
        className={`${field} min-h-[55vh] font-[family-name:var(--font-mono)]`}
        spellCheck={false}
        value={editor.content}
        disabled={locked}
        onChange={(event) =>
          onChange({ ...editor, content: event.target.value })
        }
      />
      <Button
        className="mt-2"
        variant="primary"
        disabled={locked || !unsaved}
        onClick={onSave}
      >
        {t("common.save")}
      </Button>
    </>
  );
}

function ContentPreview({
  data,
  mode,
  l,
}: {
  data: SkillView;
  mode: ViewMode;
  l: Localize;
}) {
  return mode === "diff" ? (
    <>
      <p className="text-xs text-[var(--color-ink-2)]">
        {data.version === "upstream"
          ? l("基準版以降の上流の変更", "Upstream changes since baseline")
          : l("基準版とローカルの変更", "Local changes against baseline")}
      </p>
      <pre className={`${code} max-h-[65vh]`}>
        {data.diff || l("差分はありません。", "No differences.")}
      </pre>
    </>
  ) : data.binary ? (
    <p className="text-sm">
      {l(
        "バイナリの内容はプレビューできません。名前・種類・サイズはファイル一覧で確認できます。",
        "Binary preview is unavailable. The file list shows its name, type, and size."
      )}
    </p>
  ) : mode === "markdown" && data.html ? (
    <SafeMarkdown
      html={data.html}
      failure={l(
        "Markdown を表示できません。ソース表示で確認してください。",
        "Cannot display Markdown. Switch to Source."
      )}
    />
  ) : (
    <pre className={`${code} max-h-[65vh]`}>
      {data.content ??
        l(
          "この版には内容がありません。",
          "No content available for this version."
        )}
    </pre>
  );
}

function ContentViewer({
  data,
  mode,
  versions,
  busy,
  editable,
  locked,
  onVersionChange,
  onModeChange,
  onEdit,
  children,
  l,
}: {
  data: SkillView;
  mode: ViewMode;
  versions: Record<SkillVersion, string>;
  busy: boolean;
  editable: boolean;
  locked: boolean;
  onVersionChange: (version: SkillVersion) => void;
  onModeChange: (mode: ViewMode) => void;
  onEdit: () => void;
  children: ReactNode;
  l: Localize;
}) {
  const selected = data.files.find((item) => item.path === data.selectedFile);
  return (
    <section
      className={`${panel} min-w-0`}
      aria-label={l("内容と差分", "Content and diff")}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="skill-version" className="text-sm">
          {l("表示中の版", "Viewing version")}
        </label>
        <select
          id="skill-version"
          className={`${field} w-auto min-w-0`}
          value={data.version}
          disabled={busy}
          onChange={(event) =>
            onVersionChange(event.target.value as SkillVersion)
          }
        >
          {data.versions.map((value) => (
            <option key={value} value={value}>
              {versions[value]}
            </option>
          ))}
        </select>
      </div>
      <p className="break-all font-[family-name:var(--font-mono)] text-xs">
        {data.selectedFile} · {selected?.size.toLocaleString() ?? "?"} B
      </p>
      <div
        className="mb-3 flex flex-wrap gap-2"
        role="group"
        aria-label={l("表示方法", "Display mode")}
      >
        {(["markdown", "source", "diff"] as const).map((value) => (
          <Button
            key={value}
            aria-pressed={mode === value}
            disabled={busy || (value === "markdown" && !data.html)}
            onClick={() => onModeChange(value)}
          >
            {value === "markdown"
              ? "Markdown"
              : value === "source"
                ? l("ソース", "Source")
                : l("差分", "Diff")}
          </Button>
        ))}
        <Button
          aria-pressed={mode === "editor"}
          disabled={
            !editable ||
            !data.workspace ||
            data.version !== "work" ||
            data.binary ||
            data.truncated ||
            data.content === null ||
            locked
          }
          onClick={onEdit}
        >
          {l("編集", "Edit")}
        </Button>
      </div>
      {data.truncated ? (
        <Message
          text={l(
            "表示上限を超えたため内容を省略しています。この画面では保存できません。",
            "Content exceeds the display limit and is truncated. Saving is disabled."
          )}
        />
      ) : null}
      {children}
    </section>
  );
}

function ValidationControls({
  data,
  locked,
  unsaved,
  fetching,
  validated,
  reviewed,
  onValidate,
  onReview,
  onApply,
  onDiscard,
  l,
}: {
  data: SkillView;
  locked: boolean;
  unsaved: boolean;
  fetching: boolean;
  validated: string;
  reviewed: string;
  onValidate: () => void;
  onReview: () => void;
  onApply: () => void;
  onDiscard: () => void;
  l: Localize;
}) {
  const confirm = useConfirm();
  const workspace = data.workspace;
  const canApply =
    !locked &&
    !unsaved &&
    data.version === "work" &&
    !fetching &&
    validated === data.revision &&
    reviewed === data.revision &&
    !workspace?.issues.length &&
    !workspace?.conflicts.length &&
    !workspace?.baseChanged;
  return (
    <section
      className={`${panel} mt-3`}
      aria-label={l("作業の検証と適用", "Validate and apply work")}
    >
      <p className="m-0 mb-3 text-xs text-[var(--color-ink-2)]">
        {l(
          "保存 → 差分確認 → 検証 → 適用。検証は構文・名前・パスの確認で、スクリプトの動作保証ではありません。",
          "Save → review diff → validate → apply. Validation checks syntax, names, and paths; it does not verify script behavior."
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={locked || unsaved} onClick={onValidate}>
          {l("検証", "Validate")}
        </Button>
        <Button disabled={locked || unsaved} onClick={onReview}>
          {l("作業の差分を確認", "Review work diff")}
        </Button>
        <Button
          variant="primary"
          disabled={!canApply}
          onClick={async () => {
            if (
              await confirm({
                title: l("作業用コピーを適用しますか？", "Apply working copy?"),
                body: l(
                  "同名の Vendor として登録し、利用中の版へ反映します。既存の有効状態と Deck は維持します。",
                  "Registers a vendor skill with the same name and updates the installed copy. Existing selection and decks are preserved."
                ),
                confirmLabel: l("適用", "Apply"),
              })
            )
              onApply();
          }}
        >
          {l("適用", "Apply")}
        </Button>
        <Button
          variant="danger"
          disabled={locked}
          onClick={async () => {
            if (
              await confirm({
                title: l("作業を破棄しますか？", "Discard working copy?"),
                body: l(
                  "保存した編集と会話履歴を破棄します。利用中の版は変わりません。",
                  "Discards saved edits and conversation history. The installed version stays unchanged."
                ),
                confirmLabel: l("作業を破棄", "Discard work"),
                tone: "danger",
              })
            )
              onDiscard();
          }}
        >
          {l("作業を破棄", "Discard work")}
        </Button>
      </div>
      <p role="status" className="mb-0 text-xs">
        {validated === data.revision &&
        !workspace?.issues.length &&
        !workspace?.conflicts.length
          ? l("検証済み", "Validated")
          : l(
              "現在の変更は未検証",
              "Current changes have not been validated"
            )}{" "}
        ·{" "}
        {reviewed === data.revision
          ? l("差分確認済み", "Diff reviewed")
          : l("差分を確認してください", "Review the diff")}
      </p>
    </section>
  );
}

/* eslint-disable react-doctor/no-array-index-as-key -- Messages append within a thread and stream text in place; thread + position preserves identity. */
function ConversationHistory({
  state,
  l,
}: {
  state?: SkillCodexState;
  l: Localize;
}) {
  return (
    <div
      className="max-h-[45vh] space-y-3 overflow-auto"
      aria-label={l("会話履歴", "Conversation history")}
    >
      {/* Messages append within a thread; streaming text keeps the same thread + position key. */}
      {state?.messages.map((message, index) => (
        <div
          key={`${state.threadId ?? "pending"}:${index}`}
          className="rounded border border-[var(--color-rule)] p-2"
        >
          <p className="m-0 mb-1 text-xs font-semibold">{message.role}</p>
          <p className="m-0 whitespace-pre-wrap break-words text-sm">
            {message.text}
          </p>
        </div>
      ))}
    </div>
  );
}
/* eslint-enable react-doctor/no-array-index-as-key */

function WorkspaceToolbar({
  source,
  editable,
  hasWork,
  locked,
  unsaved,
  active,
  busy,
  chat,
  onFork,
  onChat,
  l,
}: {
  source?: string;
  editable: boolean;
  hasWork: boolean;
  locked: boolean;
  unsaved: boolean;
  active: boolean;
  busy: boolean;
  chat: boolean;
  onFork: () => void;
  onChat: () => void;
  l: Localize;
}) {
  const t = useT();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Link
        to={source ? "/external-sources/$source" : "/global"}
        params={source ? { source } : {}}
        className="text-sm text-[var(--color-accent)] underline"
      >
        {l("一覧へ", "Back to list")}
      </Link>
      <Button disabled={!editable || locked || unsaved} onClick={onFork}>
        {hasWork ? l("作業を再開", "Resume work") : "Fork"}
      </Button>
      <Button
        disabled={!editable && !active}
        aria-expanded={chat}
        onClick={onChat}
      >
        Codex
      </Button>
      {busy ? (
        <span role="status" className="text-sm">
          {t("common.processing")}
        </span>
      ) : null}
    </div>
  );
}

function ViewStatus({
  pending,
  error,
  onRetry,
  onReturnSource,
  l,
}: {
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
  onReturnSource: () => void;
  l: Localize;
}) {
  const t = useT();
  return (
    <>
      {" "}
      {pending ? <p role="status">{t("common.loading")}</p> : null}
      {!!error ? (
        <div role="alert">
          <Message text={error.message} />
          <Button onClick={onRetry}>{l("再試行", "Retry")}</Button>
          <Button onClick={onReturnSource}>
            {l("正本の SKILL.md に戻る", "Return to source SKILL.md")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function WorkspaceNotices({
  editable,
  active,
  unsaved,
  l,
}: {
  editable: boolean;
  active: boolean;
  unsaved: boolean;
  l: Localize;
}) {
  return (
    <>
      {" "}
      {!editable ? (
        <Message
          text={l("このスキルは閲覧専用です。", "This skill is view only.")}
        />
      ) : null}
      {active ? (
        <Message
          text={l(
            "Codex が作業中です。停止するまで手動での変更・適用・破棄はできません。",
            "Codex is working. Stop it before manual changes, apply, or discard."
          )}
        />
      ) : null}
      {unsaved ? (
        <Message
          text={l(
            "未保存の編集があります。検証・Codex・適用の前に保存してください。",
            "You have unsaved edits. Save before validation, Codex, or apply."
          )}
        />
      ) : null}
    </>
  );
}

function isForkableSkill(data: SkillView | undefined, source?: string) {
  return (
    !!data &&
    ["external", "vendor", "untracked"].includes(data.kind) &&
    (data.kind !== "untracked" || !!(source || data.ref.source))
  );
}

function useWorkspaceRequests(
  ref: SkillRef,
  version: SkillVersion,
  file: string,
  unsaved: boolean,
  onActionSuccess: (result: SkillView, action: SkillAction) => void,
  onCodexStart: () => void
) {
  const qc = useQueryClient();
  const { name, source, skillPath } = ref;
  const key = useMemo(
    () => ["skill-workspace", name, source ?? "", skillPath ?? ""],
    [name, source, skillPath]
  );
  const codexKey = ["skill-codex", name, source ?? "", skillPath ?? ""];

  const view = useQuery({
    queryKey: [...key, version, file],
    queryFn: ({ signal }) => api.view(ref, version, file, signal),
    retry: false,
    refetchOnWindowFocus: !unsaved,
    refetchInterval: () => (isActive(qc.getQueryData(codexKey)) ? 1500 : false),
  });
  const data = view.data;
  const hasWork = !!data?.workspace;
  const editable = isForkableSkill(data, source);
  // 状態の取得だけではApp Serverを起動しない。再開時にも実行中の作業を保護する。
  const codex = useQuery({
    queryKey: codexKey,
    queryFn: ({ signal }) => api.codex(ref, signal),
    enabled: (hasWork && editable) || isActive(qc.getQueryData(codexKey)),
    retry: false,
    refetchInterval: (query) => (isActive(query.state.data) ? 1000 : false),
  });
  const active = isActive(codex.data);

  const previousActive = useRef(active);
  useEffect(() => {
    if (previousActive.current && !active) {
      void qc.invalidateQueries({ queryKey: key });
    }
    previousActive.current = active;
  }, [active, qc, key]);
  const action = useMutation({
    mutationFn: ({
      action,
      fields,
    }: {
      action: SkillAction;
      fields?: {
        path?: string;
        content?: string;
        revision?: string;
        choice?: "work" | "upstream";
      };
    }) => api.action(action, ref, fields),
    onSuccess: (result, variables) => {
      qc.setQueryData([...key, result.version, result.selectedFile], result);
      void qc.invalidateQueries({ queryKey: key });
      onActionSuccess(result, variables.action);
      if (variables.action === "apply") void qc.invalidateQueries();
      if (variables.action === "discard")
        qc.removeQueries({ queryKey: codexKey });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const codexAction = useMutation({
    mutationFn: (operation: CodexOperation) => {
      if (operation.action === "start") return api.start(ref, operation.prompt);
      if (operation.action === "interrupt") return api.interrupt(ref);
      return api.approve(ref, operation.id, operation.decision);
    },
    onSuccess: (state, operation) => {
      qc.setQueryData(codexKey, state);
      if (operation.action === "start") {
        onCodexStart();
      }
      void qc.invalidateQueries({ queryKey: key });
      void codex.refetch();
    },
  });
  const busy = action.isPending || codexAction.isPending;
  const locked = active || busy || (hasWork && codex.isFetching && !codex.data);
  const upstreamDisabled = !editable || locked || unsaved;
  return {
    view,
    codex,
    action,
    codexAction,
    hasWork,
    editable,
    active,
    busy,
    locked,
    workDisabled: upstreamDisabled || !hasWork,
    reconnectDisabled: busy || codex.isFetching || !hasWork,
    upstreamDisabled,
  };
}

function skillVersionLabels(l: Localize): Record<SkillVersion, string> {
  return {
    source: l("正本", "Source"),
    upstream: l("上流最新版", "Latest upstream"),
    work: l("作業用コピー", "Working copy"),
    installed: l("インストール済み", "Installed"),
    baseline: l("基準版", "Baseline"),
  };
}

function FileContent({
  data,
  mode,
  editor,
  locked,
  unsaved,
  onChange,
  onSave,
  l,
}: {
  data: SkillView;
  mode: ViewMode;
  editor: Editor | null;
  locked: boolean;
  unsaved: boolean;
  onChange: (editor: Editor) => void;
  onSave: (editor: Editor) => void;
  l: Localize;
}) {
  return mode === "editor" && editor ? (
    <FileEditor
      editor={editor}
      locked={locked}
      unsaved={unsaved}
      onChange={onChange}
      onSave={() => onSave(editor)}
      l={l}
    />
  ) : (
    <ContentPreview data={data} mode={mode} l={l} />
  );
}

function useUnsavedEditor(
  unsaved: boolean,
  onDiscard: () => void,
  l: Localize
) {
  const confirm = useConfirm();
  useBlocker({
    disabled: !unsaved,
    enableBeforeUnload: unsaved,
    shouldBlockFn: async () =>
      !(await confirm({
        title: l("未保存の編集を破棄しますか？", "Discard unsaved edits?"),
        body: l(
          "このファイルの編集はまだ保存されていません。",
          "Your edits to this file have not been saved."
        ),
        confirmLabel: l("破棄して移動", "Discard and leave"),
        tone: "danger",
      })),
  });

  async function leaveEditor() {
    if (
      unsaved &&
      !(await confirm({
        title: l("未保存の編集を破棄しますか？", "Discard unsaved edits?"),
        confirmLabel: l("破棄", "Discard"),
        tone: "danger",
      }))
    )
      return false;
    onDiscard();
    return true;
  }

  return leaveEditor;
}

export function SkillWorkspacePage({
  name,
  source,
  skillPath,
  prompt: initialPrompt = "",
}: SkillRef & { prompt?: string }) {
  const { settings } = useUiSettings();
  const l = (ja: string, en: string) => (settings.locale === "ja" ? ja : en);
  const ref: SkillRef = {
    name,
    ...(source ? { source } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
  const [version, setVersion] = useState<SkillVersion>("source");
  const [file, setFile] = useState("SKILL.md");
  const [mode, setMode] = useState<ViewMode>("markdown");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [chat, setChat] = useState(!!initialPrompt);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [validated, setValidated] = useState("");
  const [reviewed, setReviewed] = useState("");
  const unsaved = !!editor && editor.content !== editor.original;

  const {
    view,
    codex,
    action,
    codexAction,
    hasWork,
    editable,
    active,
    busy,
    locked,
    workDisabled,
    reconnectDisabled,
    upstreamDisabled,
  } = useWorkspaceRequests(
    ref,
    version,
    file,
    unsaved,
    (result, operation) => {
      if (operation !== "validate" && operation !== "check-upstream") {
        setEditor(null);
        setVersion(result.version);
        setFile(result.selectedFile);
        setMode(
          ["merge-upstream", "reconcile-source"].includes(operation)
            ? "diff"
            : "source"
        );
        setValidated("");
        setReviewed("");
      }
      if (operation === "validate") setValidated(result.revision);
    },
    () => {
      setPrompt("");
      setEditor(null);
      setVersion("work");
      setMode("diff");
      setValidated("");
      setReviewed("");
    }
  );
  const data = view.data;
  useEffect(() => {
    if (mode === "diff" && data?.version === "work" && !active)
      setReviewed(data.revision);
  }, [mode, data?.version, data?.revision, active]);

  const leaveEditor = useUnsavedEditor(unsaved, () => setEditor(null), l);

  const versions = skillVersionLabels(l);

  return (
    <WorkbenchShell
      title={name}
      current={source ? "external-sources" : "global"}
      overline={`Skill · ${data?.kind ?? "…"}`}
      sub={
        data ? `${versions[data.version]} · ${source ?? data.kind}` : undefined
      }
      drawer={
        chat ? (
          <CodexConversation
            state={codex.data}
            queryError={codex.error as Error | null}
            actionError={codexAction.error as Error | null}
            fetching={codex.isFetching}
            busy={busy}
            workDisabled={workDisabled}
            reconnectDisabled={reconnectDisabled}
            prompt={prompt}
            onPromptChange={setPrompt}
            onClose={() => setChat(false)}
            onAction={codexAction.mutate}
            onReconnect={() => void codex.refetch()}
            l={l}
          />
        ) : undefined
      }
    >
      <WorkspaceToolbar
        source={source}
        editable={editable}
        hasWork={hasWork}
        locked={locked}
        unsaved={unsaved}
        active={active}
        busy={busy}
        chat={chat}
        onFork={() => {
          if (hasWork) {
            setVersion("work");
            setFile("SKILL.md");
            setMode("source");
          } else action.mutate({ action: "fork" });
        }}
        onChat={() => setChat(!chat)}
        l={l}
      />
      <Message
        text={(action.error as Error | null)?.message || data?.message}
      />
      <ViewStatus
        pending={view.isPending}
        error={view.isError ? (view.error as Error) : null}
        onRetry={() => void view.refetch()}
        onReturnSource={async () => {
          if (await leaveEditor()) {
            setVersion("source");
            setFile("SKILL.md");
            setMode("source");
          }
        }}
        l={l}
      />
      {data ? (
        <>
          <WorkspaceNotices
            editable={editable}
            active={false}
            unsaved={false}
            l={l}
          />
          <UpstreamTracking
            upstream={data.upstream}
            disabled={upstreamDisabled}
            hasWork={hasWork}
            onCheck={() => action.mutate({ action: "check-upstream" })}
            onMerge={() => action.mutate({ action: "merge-upstream" })}
            l={l}
          />
          <WorkspaceNotices
            editable={true}
            active={active}
            unsaved={unsaved}
            l={l}
          />
          <WorkspaceIssues
            workspace={data.workspace}
            locked={locked}
            unsaved={unsaved}
            version={data.version}
            onReconcile={() =>
              action.mutate({
                action: "reconcile-source",
                fields: { revision: data.revision },
              })
            }
            onResolve={(path, choice) =>
              action.mutate({
                action: "resolve-conflict",
                fields: { path, choice, revision: data.revision },
              })
            }
            l={l}
          />
          <div className="grid items-start gap-3 min-[1100px]:grid-cols-[minmax(130px,0.3fr)_minmax(0,1fr)]">
            <FileList
              files={data.files}
              selectedFile={data.selectedFile}
              busy={busy}
              l={l}
              onSelect={async (path) => {
                if (await leaveEditor()) {
                  setFile(path);
                  if (mode === "editor") setMode("source");
                }
              }}
            />
            <ContentViewer
              data={data}
              mode={mode}
              versions={versions}
              busy={busy}
              editable={editable}
              locked={locked}
              l={l}
              onVersionChange={async (next) => {
                if (await leaveEditor()) {
                  setVersion(next);
                  setFile("SKILL.md");
                  if (mode === "editor") setMode("source");
                }
              }}
              onModeChange={async (next) => {
                if (await leaveEditor()) setMode(next);
              }}
              onEdit={() => {
                setMode("editor");
                if (!editor)
                  setEditor({
                    path: data.selectedFile,
                    content: data.content ?? "",
                    original: data.content ?? "",
                    revision: data.revision,
                  });
              }}
            >
              <FileContent
                data={data}
                mode={mode}
                editor={editor}
                locked={locked}
                unsaved={unsaved}
                onChange={setEditor}
                l={l}
                onSave={(editor) =>
                  action.mutate({
                    action: "save",
                    fields: {
                      path: editor.path,
                      content: editor.content,
                      revision: editor.revision,
                    },
                  })
                }
              />
            </ContentViewer>
          </div>
          {hasWork && editable ? (
            <ValidationControls
              data={data}
              locked={locked}
              unsaved={unsaved}
              fetching={view.isFetching}
              validated={validated}
              reviewed={reviewed}
              l={l}
              onValidate={() => action.mutate({ action: "validate" })}
              onReview={() => {
                setVersion("work");
                setMode("diff");
              }}
              onApply={() =>
                action.mutate({
                  action: "apply",
                  fields: { revision: data.revision },
                })
              }
              onDiscard={() => action.mutate({ action: "discard" })}
            />
          ) : null}
        </>
      ) : null}
    </WorkbenchShell>
  );
}
