import { useEffect, useRef, useState, type ReactNode } from "react";
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
  if (mode === "diff")
    return (
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
  return (
    <pre className={`${code} max-h-[65vh]`}>
      {data.content ??
        l(
          "この版には内容がありません。",
          "No content available for this version."
        )}
    </pre>
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
