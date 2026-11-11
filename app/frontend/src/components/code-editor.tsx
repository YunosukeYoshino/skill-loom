import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { codeLanguage } from "./code-language";

async function loadLanguage(path: string): Promise<Extension> {
  switch (codeLanguage(path)) {
    case "markdown": {
      const [{ markdown }, { yamlFrontmatter }] = await Promise.all([
        import("@codemirror/lang-markdown"),
        import("@codemirror/lang-yaml"),
      ]);
      return yamlFrontmatter({ content: markdown() });
    }
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "shell":
      return StreamLanguage.define(
        (await import("@codemirror/legacy-modes/mode/shell")).shell
      );
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
      });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: /x$/i.test(path),
      });
    default:
      return [];
  }
}

// DESIGN.md のトークンだけで配色し、アクセント以外の色相を増やさない。
const highlight = HighlightStyle.define([
  {
    tag: [tags.heading1, tags.heading2, tags.heading3],
    fontWeight: "700",
    color: "var(--color-ink)",
  },
  { tag: tags.heading, fontWeight: "600", color: "var(--color-ink)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: [tags.link, tags.url],
    color: "var(--color-accent-text)",
    textDecoration: "underline",
  },
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword],
    color: "var(--color-accent-text)",
    fontWeight: "600",
  },
  {
    tag: [tags.propertyName, tags.definition(tags.propertyName)],
    color: "var(--color-accent-text)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.monospace],
    color: "var(--color-warn-text)",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: "var(--color-accent-hover)",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--color-ink-2)",
    fontStyle: "italic",
  },
  {
    tag: [tags.meta, tags.processingInstruction, tags.contentSeparator],
    color: "var(--color-ink-2)",
  },
  { tag: tags.quote, color: "var(--color-ink-2)" },
  { tag: tags.invalid, color: "var(--color-danger)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--text-sm)",
    color: "var(--color-ink)",
    backgroundColor: "var(--color-paper)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "var(--space-xs) 0",
    caretColor: "var(--color-accent)",
  },
  ".cm-line": { padding: "0 var(--space-sm) 0 var(--space-2xs)" },
  ".cm-gutters": {
    backgroundColor: "var(--color-paper-2)",
    color: "var(--color-ink-2)",
    border: "none",
    borderRight: "1px solid var(--color-rule)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 var(--space-2xs) 0 var(--space-xs)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-activeLine": { backgroundColor: "oklch(52% 0.175 255 / 0.05)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--color-accent-soft)",
    color: "var(--color-accent-text)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "oklch(52% 0.175 255 / 0.18)" },
  ".cm-selectionMatch": { backgroundColor: "var(--color-accent-soft)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--color-accent-soft)",
    outline: "1px solid var(--color-rule-strong)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--color-warn-soft)",
    outline: "1px solid var(--color-warn)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "oklch(70% 0.14 75 / 0.35)",
  },
  ".cm-panels": {
    backgroundColor: "var(--color-paper-2)",
    color: "var(--color-ink)",
    fontFamily: "var(--font-body)",
  },
  ".cm-panels-top": { borderBottom: "1px solid var(--color-rule)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--color-rule)" },
  ".cm-panel input, .cm-panel button": { fontSize: "var(--text-xs)" },
  ".cm-textfield": {
    border: "1px solid var(--color-rule)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-paper)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--color-paper)",
    border: "1px solid var(--color-rule)",
    borderRadius: "var(--radius-sm)",
  },
});

export default function CodeEditor({
  value,
  path,
  label,
  readOnly = false,
  onChange,
  onSave,
}: {
  value: string;
  path: string;
  label: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const language = useRef(new Compartment());
  const access = useRef(new Compartment());
  const attributes = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          syntaxHighlighting(highlight),
          theme,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                callbacks.current.onSave?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange?.(update.state.doc.toString());
          }),
          language.current.of([]),
          access.current.of(accessExtension(readOnly)),
          attributes.current.of(
            EditorView.contentAttributes.of({ "aria-label": label })
          ),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // 初期値だけで生成し、以降の変化は下の effect で差し替える。
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(path).then((extension) => {
      if (!cancelled)
        view.current?.dispatch({
          effects: language.current.reconfigure(extension),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        access.current.reconfigure(accessExtension(readOnly)),
        attributes.current.reconfigure(
          EditorView.contentAttributes.of({ "aria-label": label })
        ),
      ],
    });
  }, [readOnly, label]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value)
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
  }, [value]);

  return <div ref={host} className="h-full min-h-0" />;
}

function accessExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
