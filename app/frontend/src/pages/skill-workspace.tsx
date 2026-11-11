import type { SkillRef, SkillView } from "@shared/skill-workspace-types";
import { Message, WorkbenchShell } from "@/components/ui";
import { useUiSettings } from "@/settings/react";
import {
  FileList,
  ContentViewer,
  FileContent,
} from "@/components/skill-workspace-content";
import {
  CodexConversation,
  UpstreamTracking,
  WorkspaceIssues,
  ValidationControls,
  WorkspaceToolbar,
  ViewStatus,
  WorkspaceNotices,
  skillVersionLabels,
} from "@/components/skill-workspace-controls";
import { useWorkspaceSession, useUnsavedEditor } from "./use-skill-workspace";
import { splitsEditor, type Localize } from "./skill-workspace-model";

export function SkillWorkspacePage({
  name,
  source,
  skillPath,
  prompt: initialPrompt = "",
}: SkillRef & { prompt?: string }) {
  const { settings } = useUiSettings();
  const l = (ja: string, en: string) => (settings.locale === "ja" ? ja : en);
  const ref = { name, source, skillPath };
  const session = useWorkspaceSession(ref, initialPrompt);
  const {
    setMode,
    setEditor,
    chat,
    setChat,
    prompt,
    setPrompt,
    unsaved,
    view,
    codex,
    action,
    codexAction,
    hasWork,
    editable,
    active,
    busy,
    upstreamDisabled,
    workDisabled,
    reconnectDisabled,
    setVersion,
    setFile,
  } = session;
  const data = view.data;
  const leaveEditor = useUnsavedEditor(unsaved, () => setEditor(null), l);

  const heading = workspaceHeading(data, source, l);

  return (
    <WorkbenchShell
      title={name}
      current={source ? "external-sources" : "global"}
      overline={heading.overline}
      sub={heading.sub}
      fillEmptyDrawer
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
        forkDisabled={upstreamDisabled}
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
      <WorkspaceViewStatus session={session} leaveEditor={leaveEditor} l={l} />
      <WorkspaceBody session={session} leaveEditor={leaveEditor} l={l} />
    </WorkbenchShell>
  );
}

// 並べて編集する間はファイル一覧を上に回し、横幅を本文に譲る。
function filesGrid(splitEditor: boolean) {
  return splitEditor
    ? "grid items-start gap-3"
    : "grid items-start gap-3 min-[1100px]:grid-cols-[minmax(130px,0.3fr)_minmax(0,1fr)]";
}

function WorkspaceBody({
  session,
  leaveEditor,
  l,
}: {
  session: ReturnType<typeof useWorkspaceSession>;
  leaveEditor: () => Promise<boolean>;
  l: Localize;
}) {
  const {
    mode,
    setMode,
    editor,
    setEditor,
    unsaved,
    view,
    action,
    hasWork,
    editable,
    active,
    busy,
    locked,
    upstreamDisabled,
    changesDisabled,
    validated,
    reviewed,
    setFile,
    setVersion,
  } = session;
  const data = view.data;
  const versions = skillVersionLabels(l);
  if (!data) return null;
  const splitEditor = splitsEditor(mode, editor);
  return (
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
        changesDisabled={changesDisabled}
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
      <div className={filesGrid(splitEditor)}>
        <FileList
          files={data.files}
          selectedFile={data.selectedFile}
          busy={busy}
          compact={splitEditor}
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
  );
}

function workspaceHeading(
  data: SkillView | undefined,
  source: string | undefined,
  l: Localize
) {
  if (!data) return { overline: "Skill · …", sub: undefined };
  const versions = skillVersionLabels(l);
  return {
    overline: `Skill · ${data.kind}`,
    sub: `${versions[data.version]} · ${source ?? data.kind}`,
  };
}

function WorkspaceViewStatus({
  session,
  leaveEditor,
  l,
}: {
  session: ReturnType<typeof useWorkspaceSession>;
  leaveEditor: () => Promise<boolean>;
  l: Localize;
}) {
  const { action, view, setVersion, setFile, setMode } = session;
  const data = view.data;
  return (
    <>
      <Message text={[action.error?.message, data?.message].find(Boolean)} />
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
    </>
  );
}
