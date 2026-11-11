# 4. Source Editor with Live Preview for Skill Files

Date: 2026-11-11

## Status

Accepted.

## Context

The Skill workspace edited files in a plain textarea, and Markdown could only be checked in a separate view. A WYSIWYG editor (Tiptap, Milkdown, and similar) was considered because it looks the most modern.

WYSIWYG editors parse Markdown into their own document model and serialize it back on save. The round trip normalizes list markers, emphasis syntax, blank lines, tables, and escapes, and it does not preserve YAML frontmatter verbatim. A Skill's frontmatter must stay exact, and every change to a working copy is reviewed as a text diff before Apply. Changes caused only by serialization would end up in that review.

## Decision

Skill files are edited as source text in CodeMirror 6, and Markdown is shown in a live preview next to the editor.

- Bytes are saved exactly as typed. The editor never rewrites content it did not touch.
- Highlighting is chosen from the file extension. Markdown is highlighted together with its YAML frontmatter.
- The preview is rendered by the server with the same Markdown renderer and sanitizer used for the file view, so the preview and the view cannot disagree.
- The preview sits beside the editor when the content area is wide enough, and behind Editor / Preview tabs otherwise.
- Leading YAML frontmatter is rendered as a block that shows the YAML verbatim, not as Markdown.
- Saving keeps the editor open, so editing can continue after each save.
- The Source view uses the same editor in read-only mode. Diffs keep their text form with colored lines.
- CodeMirror and its language packages are loaded only when a file is shown.

## Consequences

- Diffs of working copies contain only intended edits.
- Editing still needs Markdown knowledge; there is no rich-text toolbar.
- Each pause in typing sends one local preview request.
- CodeMirror adds a lazily loaded chunk of about 110 kB gzip.
