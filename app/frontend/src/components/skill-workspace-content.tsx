import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { skillWorkspaceApi } from "@/api/skill-workspace";
import type { SkillView, SkillVersion } from "@shared/skill-workspace-types";
import { Button, Message } from "@/components/ui";
import { useT } from "@/settings/react";
import {
  editorDisabled,
  type Editor,
  type ViewMode,
  type Localize,
} from "@/pages/skill-workspace-model";
import { panel, field, code } from "./skill-workspace-styles";
import { codeLanguage, diffLines } from "./code-language";

// CodeMirror は表示・編集時にだけ読み込み、一覧画面の初期表示を重くしない。
const CodeEditor = lazy(() => import("./code-editor"));

function SafeMarkdown({ html, failure }: { html: string; failure: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let cancelled = false;
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
    async function render(container: HTMLDivElement) {
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
    void render(container).catch(() => {
      if (cancelled) return;
      container.replaceChildren();
      setError(true);
    });
    // 先に空にするとライブプレビューのスクロール位置が先頭へ戻るため、描画時に置き換える。
    return () => {
      cancelled = true;
    };
  }, [html]);
  return (
    <>
      {error ? <Message text={failure} /> : null}
      <div ref={ref} className="skill-prose" />
    </>
  );
}

export function FileList({
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

function useLivePreview(content: string, initial: string | null) {
  const [preview, setPreview] = useState({ html: initial, failed: false });
  const first = useRef(true);
  useEffect(() => {
    // 開いた直後は閲覧時の描画結果をそのまま使い、編集してから描画し直す。
    const reuse = first.current && initial !== null;
    first.current = false;
    if (reuse) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      skillWorkspaceApi.preview(content, controller.signal).then(
        ({ html }) => setPreview({ html, failed: false }),
        () => {
          if (!controller.signal.aborted)
            setPreview((current) => ({ ...current, failed: true }));
        }
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [content]);
  return preview;
}

function EditorFallback({ l }: { l: Localize }) {
  return (
    <p className="m-0 p-3 text-sm text-[var(--color-ink-2)]">
      {l("エディタを読み込んでいます…", "Loading editor…")}
    </p>
  );
}

function FileEditor({
  editor,
  initialHtml,
  locked,
  unsaved,
  onChange,
  onSave,
  l,
}: {
  editor: Editor;
  initialHtml: string | null;
  locked: boolean;
  unsaved: boolean;
  onChange: (editor: Editor) => void;
  onSave: () => void;
  l: Localize;
}) {
  const t = useT();
  const markdown = codeLanguage(editor.path) === "markdown";
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const canSave = !locked && unsaved;
  const editorPane = (
    <div
      className={`h-[60vh] min-w-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-rule)] focus-within:border-[var(--color-focus)] focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)] ${locked ? "opacity-60" : ""}`}
    >
      <Suspense fallback={<EditorFallback l={l} />}>
        <CodeEditor
          value={editor.content}
          path={editor.path}
          label={`${l("ファイルを編集", "Edit file")} ${editor.path}`}
          readOnly={locked}
          onChange={(content) => onChange({ ...editor, content })}
          onSave={() => {
            if (canSave) onSave();
          }}
        />
      </Suspense>
    </div>
  );
  return (
    <>
      {markdown ? (
        <div className="@container">
          <div
            className="mb-2 flex gap-2 @4xl:hidden"
            role="group"
            aria-label={l("編集画面の表示", "Editor view")}
          >
            <Button
              aria-pressed={pane === "edit"}
              onClick={() => setPane("edit")}
            >
              {l("エディタ", "Editor")}
            </Button>
            <Button
              aria-pressed={pane === "preview"}
              onClick={() => setPane("preview")}
            >
              {l("プレビュー", "Preview")}
            </Button>
          </div>
          <div className="grid gap-3 @4xl:grid-cols-2">
            <div className={pane === "edit" ? "" : "hidden @4xl:block"}>
              {editorPane}
            </div>
            <div className={pane === "preview" ? "" : "hidden @4xl:block"}>
              <LivePreview
                content={editor.content}
                initialHtml={initialHtml}
                l={l}
              />
            </div>
          </div>
        </div>
      ) : (
        editorPane
      )}
      <div className="mt-2 flex items-center gap-3">
        <Button variant="primary" disabled={!canSave} onClick={onSave}>
          {t("common.save")}
        </Button>
        <span className="text-xs text-[var(--color-ink-2)]">
          <kbd className="font-[family-name:var(--font-mono)]">⌘S</kbd> /{" "}
          <kbd className="font-[family-name:var(--font-mono)]">Ctrl+S</kbd>{" "}
          {l("で保存", "to save")}
        </span>
      </div>
    </>
  );
}

function LivePreview({
  content,
  initialHtml,
  l,
}: {
  content: string;
  initialHtml: string | null;
  l: Localize;
}) {
  const preview = useLivePreview(content, initialHtml);
  return (
    <section
      aria-label={l("プレビュー", "Preview")}
      className="h-[60vh] overflow-auto rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] px-5 py-4"
    >
      {preview.failed ? (
        <Message
          text={l(
            "プレビューを更新できません。表示は最後に描画できた内容です。",
            "Cannot update the preview. Showing the last rendered content."
          )}
        />
      ) : null}
      <SafeMarkdown
        html={preview.html ?? ""}
        failure={l("Markdown を表示できません。", "Cannot display Markdown.")}
      />
    </section>
  );
}

function DiffView({ diff, l }: { diff: string; l: Localize }) {
  const lines = diffLines(diff);
  if (!lines.length)
    return (
      <p className="text-sm text-[var(--color-ink-2)]">
        {l("差分はありません。", "No differences.")}
      </p>
    );
  const tone = {
    added:
      "bg-[var(--color-success-soft)] text-[var(--color-ink)] [box-shadow:inset_3px_0_var(--color-success)]",
    removed:
      "bg-[var(--color-danger-soft)] text-[var(--color-ink)] [box-shadow:inset_3px_0_var(--color-danger)]",
    hunk: "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]",
    meta: "text-[var(--color-ink-2)]",
    context: "",
  };
  return (
    <pre
      className={`${code} max-h-[65vh] rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper)] py-2`}
    >
      {lines.map((line, index) => (
        <span key={index} className={`block px-3 ${tone[line.kind]}`}>
          {line.text || " "}
        </span>
      ))}
    </pre>
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
  if (mode === "diff")
    return (
      <>
        <p className="text-xs text-[var(--color-ink-2)]">
          {data.version === "upstream"
            ? l("基準版以降の上流の変更", "Upstream changes since baseline")
            : l("基準版とローカルの変更", "Local changes against baseline")}
        </p>
        <DiffView diff={data.diff} l={l} />
      </>
    );
  return <FilePreview data={data} mode={mode} l={l} />;
}

function FilePreview({
  data,
  mode,
  l,
}: {
  data: SkillView;
  mode: ViewMode;
  l: Localize;
}) {
  return data.binary ? (
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
    <SourcePreview data={data} l={l} />
  );
}

function SourcePreview({ data, l }: { data: SkillView; l: Localize }) {
  if (data.content === null)
    return (
      <p className="text-sm">
        {l(
          "この版には内容がありません。",
          "No content available for this version."
        )}
      </p>
    );
  return (
    <div className="h-[65vh] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-rule)]">
      <Suspense
        fallback={<pre className={`${code} h-full p-3`}>{data.content}</pre>}
      >
        <CodeEditor
          value={data.content}
          path={data.selectedFile}
          label={`${l("ファイルの内容", "File content")} ${data.selectedFile}`}
          readOnly
        />
      </Suspense>
    </div>
  );
}

export function ContentViewer({
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
            {
              {
                markdown: "Markdown",
                source: l("ソース", "Source"),
                diff: l("差分", "Diff"),
              }[value]
            }
          </Button>
        ))}
        <Button
          aria-pressed={mode === "editor"}
          disabled={editorDisabled(data, editable, locked)}
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

export function FileContent({
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
      key={editor.path}
      editor={editor}
      initialHtml={editor.content === data.content ? data.html : null}
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
