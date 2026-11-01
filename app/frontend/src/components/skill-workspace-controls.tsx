import type {
  SkillCodexState,
  SkillView,
  SkillVersion,
  SkillUpstreamStatus,
} from "@shared/skill-workspace-types";
import { Link } from "@tanstack/react-router";
import { useConfirm } from "@/components/dialog";
import { Button, Message } from "@/components/ui";
import { useT } from "@/settings/react";
import {
  isActive,
  codexFailure,
  validationState,
  upstreamState,
  type Localize,
  type CodexOperation,
} from "@/pages/skill-workspace-model";
import { panel, field, code } from "./skill-workspace-styles";

export function CodexConversation({
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
  return (
    <section
      className={panel}
      aria-label={l("Codex の会話", "Codex conversation")}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">Codex</h2>
        <Button onClick={onClose}>{l("閉じる", "Close")}</Button>
      </div>
      <CodexStatus
        state={state}
        queryError={queryError}
        actionError={actionError}
        fetching={fetching}
        l={l}
      />
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
      <CodexPrompt
        state={state}
        busy={busy}
        workDisabled={workDisabled}
        reconnectDisabled={reconnectDisabled}
        prompt={prompt}
        onPromptChange={onPromptChange}
        onAction={onAction}
        onReconnect={onReconnect}
        l={l}
      />
    </section>
  );
}

export function UpstreamTracking({
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
  const status = upstreamState(upstream, disabled, hasWork);

  return (
    <section
      className={`${panel} mb-3 text-xs ${status.blocked ? "bg-[var(--color-paper-2)] text-[var(--color-ink-2)]" : ""}`}
      aria-label={l("上流の追跡", "Upstream tracking")}
    >
      <p className="m-0 mb-2 font-semibold">{upstreamLabels[upstream.state]}</p>
      <UpstreamVersions upstream={upstream} behind={status.behind} l={l} />
      {upstream.message ? <p>{upstream.message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={onCheck}>
          {l("更新を確認", "Check upstream")}
        </Button>
        <Button disabled={status.mergeDisabled} onClick={onMerge}>
          {l("最新版を作業へ取り込む", "Merge latest into work")}
        </Button>
      </div>
    </section>
  );
}

export function WorkspaceIssues({
  workspace,
  changesDisabled,
  version,
  onReconcile,
  onResolve,
  l,
}: {
  workspace?: SkillView["workspace"];
  changesDisabled: boolean;
  version: SkillVersion;
  onReconcile: () => void;
  onResolve: (path: string, choice: "work" | "upstream") => void;
  l: Localize;
}) {
  const disabled = changesDisabled || version !== "work";
  if (!workspace) return null;
  return (
    <>
      {" "}
      {workspace.baseChanged ? (
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
      <WorkspaceConflicts
        workspace={workspace}
        disabled={disabled}
        onResolve={onResolve}
        l={l}
      />
    </>
  );
}

function WorkspaceConflicts({
  workspace,
  disabled,
  onResolve,
  l,
}: {
  workspace: NonNullable<SkillView["workspace"]>;
  disabled: boolean;
  onResolve: (path: string, choice: "work" | "upstream") => void;
  l: Localize;
}) {
  if (!workspace.issues.length && !workspace.conflicts.length) return null;
  return (
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
  );
}

export function ValidationControls({
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
  const readiness = validationState(data, {
    locked,
    unsaved,
    fetching,
    validated,
    reviewed,
  });
  const disabled = locked || unsaved;
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
        <Button disabled={disabled} onClick={onValidate}>
          {l("検証", "Validate")}
        </Button>
        <Button disabled={disabled} onClick={onReview}>
          {l("作業の差分を確認", "Review work diff")}
        </Button>
        <Button
          variant="primary"
          disabled={!readiness.canApply}
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
        {readiness.validated
          ? l("検証済み", "Validated")
          : l(
              "現在の変更は未検証",
              "Current changes have not been validated"
            )}{" "}
        ·{" "}
        {readiness.reviewed
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

export function WorkspaceToolbar({
  source,
  editable,
  hasWork,
  forkDisabled,
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
  forkDisabled: boolean;
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
      <WorkspaceBackLink source={source} l={l} />
      <Button disabled={forkDisabled} onClick={onFork}>
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

export function ViewStatus({
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

export function WorkspaceNotices({
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

export function skillVersionLabels(l: Localize): Record<SkillVersion, string> {
  return {
    source: l("正本", "Source"),
    upstream: l("上流最新版", "Latest upstream"),
    work: l("作業用コピー", "Working copy"),
    installed: l("インストール済み", "Installed"),
    baseline: l("基準版", "Baseline"),
  };
}

function UpstreamVersions({
  upstream,
  behind,
  l,
}: {
  upstream: SkillUpstreamStatus;
  behind: number | null;
  l: Localize;
}) {
  const formatCommit = (value?: { commit: string; date: string }) =>
    value
      ? `${value.commit.slice(0, 8)} · ${value.date}`
      : l("不明", "Unknown");
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
      <dt>{l("基準版", "Baseline")}</dt>
      <dd className="m-0">{formatCommit(upstream.baseline)}</dd>
      <dt>{l("上流最新版", "Latest upstream")}</dt>
      <dd className="m-0">{formatCommit(upstream.latest)}</dd>
      <dt>{l("未取り込み", "Commits behind")}</dt>
      <dd className="m-0">{behind ?? l("不明", "Unknown")}</dd>
      <UpstreamCheckTimes upstream={upstream} l={l} />
    </dl>
  );
}

function WorkspaceBackLink({ source, l }: { source?: string; l: Localize }) {
  return (
    <Link
      to={source ? "/external-sources/$source" : "/global"}
      params={source ? { source } : {}}
      className="text-sm text-[var(--color-accent)] underline"
    >
      {l("一覧へ", "Back to list")}
    </Link>
  );
}

type CodexStatusProps = {
  state?: SkillCodexState;
  queryError: Error | null;
  actionError: Error | null;
  fetching: boolean;
  l: Localize;
};
function CodexStatus({
  state,
  queryError,
  actionError,
  fetching,
  l,
}: CodexStatusProps) {
  const { error, failed } = codexFailure(state, queryError, actionError);
  return (
    <>
      <CodexConnectionStatus state={state} fetching={fetching} l={l} />
      <Message text={error} />
      {failed ? (
        <p className="text-xs">
          {l(
            "ログインが必要な場合はローカルで codex login を実行して再試行してください。手動編集は引き続き使えます。",
            "If sign-in is required, run codex login locally and retry. Manual editing remains available."
          )}
        </p>
      ) : null}
    </>
  );
}
function CodexConnectionStatus({
  state,
  fetching,
  l,
}: Pick<CodexStatusProps, "state" | "fetching" | "l">) {
  const t = useT();
  return (
    <p role="status" className="text-xs text-[var(--color-ink-2)]">
      {state?.status ??
        (fetching ? t("common.loading") : l("未接続", "Not connected"))}
    </p>
  );
}
function CodexPrompt({
  state,
  busy,
  workDisabled,
  reconnectDisabled,
  prompt,
  onPromptChange,
  onAction,
  onReconnect,
  l,
}: {
  state?: SkillCodexState;
  busy: boolean;
  workDisabled: boolean;
  reconnectDisabled: boolean;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onAction: (operation: CodexOperation) => void;
  onReconnect: () => void;
  l: Localize;
}) {
  const active = isActive(state);
  const sendDisabled = workDisabled || !prompt.trim();
  const disabled = active || busy;
  const stopDisabled = !active || busy;
  return (
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
        disabled={disabled}
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
          disabled={stopDisabled}
          onClick={() => onAction({ action: "interrupt" })}
        >
          {l("停止", "Stop")}
        </Button>
        <Button disabled={reconnectDisabled} onClick={onReconnect}>
          {l("再接続", "Reconnect")}
        </Button>
      </div>
    </form>
  );
}

function UpstreamCheckTimes({
  upstream,
  l,
}: {
  upstream: SkillUpstreamStatus;
  l: Localize;
}) {
  return (
    <>
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
    </>
  );
}
