import type {
  SkillCodexState,
  SkillRef,
  SkillView,
  SkillUpstreamStatus,
} from "../../../shared/skill-workspace-types";
import { codeLanguage } from "../components/code-language";

export type Editor = {
  path: string;
  content: string;
  original: string;
  revision: string;
};
export type Localize = (ja: string, en: string) => string;
export type ViewMode = "markdown" | "source" | "diff" | "editor";
export type CodexOperation =
  | { action: "start"; prompt: string }
  | { action: "interrupt" }
  | { action: "approve"; id: string | number; decision: "accept" | "decline" };

export function isActive(state?: SkillCodexState) {
  return !!state && ["starting", "running", "approval"].includes(state.status);
}

export function isForkableSkill(data: SkillView | undefined, source?: string) {
  if (!data) return false;
  if (data.kind === "untracked") return Boolean(source || data.ref.source);
  return ["external", "vendor"].includes(data.kind);
}

export function skillQueryKeys({
  name,
  source = "",
  skillPath = "",
}: SkillRef) {
  return {
    view: ["skill-workspace", name, source, skillPath],
    codex: ["skill-codex", name, source, skillPath],
  };
}

export function workspaceLocks(state: {
  active: boolean;
  busy: boolean;
  hasWork: boolean;
  codexLoading: boolean;
  codexFetching: boolean;
  editable: boolean;
  unsaved: boolean;
}) {
  const locked =
    state.active || state.busy || (state.hasWork && state.codexLoading);
  const changesDisabled = locked || state.unsaved;
  const upstreamDisabled = !state.editable || changesDisabled;
  return {
    locked,
    changesDisabled,
    upstreamDisabled,
    workDisabled: upstreamDisabled || !state.hasWork,
    reconnectDisabled: state.busy || state.codexFetching || !state.hasWork,
  };
}

export function editorDisabled(
  data: SkillView,
  editable: boolean,
  locked: boolean
) {
  return (
    !editable ||
    !data.workspace ||
    data.version !== "work" ||
    data.binary ||
    data.truncated ||
    data.content === null ||
    locked
  );
}

// 保存後も同じファイルを編集し続けられるよう、保存結果を新しい基準にする。
// 保存以外の操作や、編集を続けられない結果では編集を終える。
export function editorAfterAction(
  action: string,
  editor: Editor | null,
  saved: SkillView
): Editor | null {
  if (
    action !== "save" ||
    !editor ||
    saved.selectedFile !== editor.path ||
    saved.truncated ||
    saved.content === null
  )
    return null;
  return { ...editor, original: saved.content, revision: saved.revision };
}

// 編集を終えた後の表示。上流や元の版を取り込んだ操作は差分を見せる。
export function modeAfterAction(action: string): ViewMode {
  return ["merge-upstream", "reconcile-source"].includes(action)
    ? "diff"
    : "source";
}

// Markdown の編集中だけ、エディタとプレビューを並べる幅をファイル一覧から譲る。
export function splitsEditor(mode: ViewMode, editor: Editor | null) {
  return (
    mode === "editor" && !!editor && codeLanguage(editor.path) === "markdown"
  );
}

export function validationState(
  data: SkillView,
  state: {
    locked: boolean;
    unsaved: boolean;
    fetching: boolean;
    validated: string;
    reviewed: string;
  }
) {
  const workspace = data.workspace ?? {
    issues: [],
    conflicts: [],
    baseChanged: false,
  };
  const clean = !workspace.issues.length && !workspace.conflicts.length;
  const validated = state.validated === data.revision && clean;
  const reviewed = state.reviewed === data.revision;
  const requirements = {
    unlocked: !state.locked,
    saved: !state.unsaved,
    settled: !state.fetching,
    workingCopy: data.version === "work",
    validated,
    reviewed,
    sourceUnchanged: !workspace.baseChanged,
  };
  return {
    canApply: Object.values(requirements).every(Boolean),
    validated,
    reviewed,
  };
}

export function upstreamState(
  upstream: SkillUpstreamStatus,
  disabled: boolean,
  hasWork: boolean
) {
  const blocked = ["missing", "unavailable", "review"].includes(upstream.state);
  const knownLag =
    Boolean(upstream.baseline) &&
    ["current", "behind"].includes(upstream.state) &&
    upstream.behind !== null;
  const mergeDisabled =
    disabled ||
    !hasWork ||
    blocked ||
    !upstream.latest ||
    upstream.state === "current";
  return { blocked, behind: knownLag ? upstream.behind : null, mergeDisabled };
}

export function shouldReviewDiff(
  mode: ViewMode,
  version: SkillView["version"],
  active: boolean
) {
  return mode === "diff" && version === "work" && !active;
}

export function codexFailure(
  state: SkillCodexState | undefined,
  queryError: Error | null,
  actionError: Error | null
) {
  return {
    error: state?.error || queryError?.message || actionError?.message,
    failed: !!(state?.error || queryError || actionError),
  };
}
