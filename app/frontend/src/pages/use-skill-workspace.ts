import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type {
  SkillRef,
  SkillVersion,
  SkillView,
} from "@shared/skill-workspace-types";
import {
  skillWorkspaceApi as api,
  type SkillAction,
} from "@/api/skill-workspace";
import { useConfirm } from "@/components/dialog";
import {
  editorAfterSave,
  isActive,
  isForkableSkill,
  skillQueryKeys,
  workspaceLocks,
  shouldReviewDiff,
  type CodexOperation,
  type Localize,
  type Editor,
  type ViewMode,
} from "./skill-workspace-model";

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
  const keys = useMemo(() => skillQueryKeys(ref), [name, source, skillPath]);
  const key = keys.view;
  const codexKey = keys.codex;

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
  const codex = useWorkspaceCodex(ref, codexKey, hasWork && editable);
  const active = isActive(codex.data);

  const previousActive = useRef(active);
  useEffect(() => {
    if (previousActive.current && !active) {
      void qc.invalidateQueries({ queryKey: key });
    }
    previousActive.current = active;
  }, [active, qc, key]);
  const { action, codexAction, busy } = useWorkspaceMutations(
    ref,
    key,
    codexKey,
    onActionSuccess,
    onCodexStart,
    () => {
      void codex.refetch();
    }
  );
  const locks = workspaceLocks({
    active,
    busy,
    hasWork,
    codexLoading: codex.isFetching && !codex.data,
    codexFetching: codex.isFetching,
    editable,
    unsaved,
  });
  return {
    view,
    codex,
    action,
    codexAction,
    hasWork,
    editable,
    active,
    busy,
    ...locks,
  };
}

export function useUnsavedEditor(
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

function useWorkspaceMutations(
  ref: SkillRef,
  key: string[],
  codexKey: string[],
  onActionSuccess: (result: SkillView, action: SkillAction) => void,
  onCodexStart: () => void,
  refetchCodex: () => void
) {
  const qc = useQueryClient();
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
      refetchCodex();
    },
  });
  const busy = action.isPending || codexAction.isPending;
  return { action, codexAction, busy };
}

function useWorkspaceCodex(
  ref: SkillRef,
  codexKey: string[],
  hasEditableWork: boolean
) {
  const qc = useQueryClient();
  // 状態の取得だけではApp Serverを起動しない。再開時にも実行中の作業を保護する。
  const codex = useQuery({
    queryKey: codexKey,
    queryFn: ({ signal }) => api.codex(ref, signal),
    enabled: hasEditableWork || isActive(qc.getQueryData(codexKey)),
    retry: false,
    refetchInterval: (query) => (isActive(query.state.data) ? 1000 : false),
  });

  return codex;
}

export function useWorkspaceSession(
  reference: SkillRef,
  initialPrompt: string
) {
  const { name, source, skillPath } = reference;
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
    changesDisabled,
  } = useWorkspaceRequests(
    ref,
    version,
    file,
    unsaved,
    (result, operation) => {
      const resumed =
        operation === "save" ? editorAfterSave(editor, result) : null;
      if (resumed) {
        // 保存中に打った文字を落とさないよう、応答時点の編集内容に基準だけ重ねる。
        setEditor((current) => editorAfterSave(current, result));
        setVersion(result.version);
        setFile(result.selectedFile);
        setValidated("");
        setReviewed("");
      } else if (!["validate", "check-upstream"].includes(operation)) {
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
  useReviewedRevision(mode, data, active, setReviewed);

  return {
    version,
    setVersion,
    file,
    setFile,
    mode,
    setMode,
    editor,
    setEditor,
    chat,
    setChat,
    prompt,
    setPrompt,
    validated,
    reviewed,
    unsaved,
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
    changesDisabled,
  };
}

function useReviewedRevision(
  mode: ViewMode,
  data: SkillView | undefined,
  active: boolean,
  setReviewed: (revision: string) => void
) {
  useEffect(() => {
    if (!data) return;
    if (shouldReviewDiff(mode, data.version, active))
      setReviewed(data.revision);
  }, [mode, data?.version, data?.revision, active]);
}
