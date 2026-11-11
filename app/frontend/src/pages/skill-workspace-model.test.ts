import { describe, expect, test } from "bun:test";
import type { SkillView } from "../../../shared/skill-workspace-types";
import {
  isForkableSkill,
  validationState,
  upstreamState,
  editorDisabled,
  workspaceLocks,
  shouldReviewDiff,
  codexFailure,
  editorAfterSave,
} from "./skill-workspace-model";

const view: SkillView = {
  ref: { name: "example", source: "owner/repo" },
  kind: "external",
  version: "work",
  versions: ["source", "work"],
  files: [],
  selectedFile: "SKILL.md",
  content: "# Example",
  html: "<h1>Example</h1>",
  binary: false,
  truncated: false,
  revision: "reviewed",
  workspace: { dirty: true, conflicts: [], issues: [], baseChanged: false },
  diff: "+Example",
  upstream: { state: "unchecked", behind: null },
};

test("only an idle working-copy diff counts as reviewed", () => {
  expect(shouldReviewDiff("diff", "work", false)).toBe(true);
  expect(shouldReviewDiff("source", "work", false)).toBe(false);
  expect(shouldReviewDiff("diff", "source", false)).toBe(false);
  expect(shouldReviewDiff("diff", "work", true)).toBe(false);
});

test("Codex failure presentation preserves message priority and empty-message errors", () => {
  const state = {
    status: "failed" as const,
    error: "session",
    messages: [],
    approvals: [],
  };
  expect(codexFailure(state, new Error("query"), new Error("action"))).toEqual({
    error: "session",
    failed: true,
  });
  expect(
    codexFailure(undefined, new Error("query"), new Error("action"))
  ).toEqual({ error: "query", failed: true });
  expect(codexFailure(undefined, new Error(""), new Error("action"))).toEqual({
    error: "action",
    failed: true,
  });
  expect(codexFailure(undefined, new Error(""), null)).toEqual({
    error: undefined,
    failed: true,
  });
  expect(codexFailure(undefined, null, null)).toEqual({
    error: undefined,
    failed: false,
  });
});

describe("workspace operation policy", () => {
  const ready = {
    locked: false,
    unsaved: false,
    fetching: false,
    validated: "reviewed",
    reviewed: "reviewed",
  };
  test("apply requires the current saved, reviewed and validated working tree", () => {
    expect(validationState(view, ready)).toEqual({
      canApply: true,
      validated: true,
      reviewed: true,
    });
    for (const key of ["locked", "unsaved", "fetching"] as const) {
      expect(validationState(view, { ...ready, [key]: true }).canApply).toBe(
        false
      );
    }
    expect(
      validationState(view, { ...ready, validated: "older" }).canApply
    ).toBe(false);
    expect(
      validationState(view, { ...ready, reviewed: "older" }).canApply
    ).toBe(false);
    expect(
      validationState({ ...view, version: "source" }, ready).canApply
    ).toBe(false);
  });
  test("conflicts, validation issues and changed sources keep apply blocked", () => {
    for (const workspace of [
      { ...view.workspace!, conflicts: ["SKILL.md"] },
      { ...view.workspace!, issues: ["invalid YAML"] },
      { ...view.workspace!, baseChanged: true },
    ]) {
      expect(validationState({ ...view, workspace }, ready).canApply).toBe(
        false
      );
    }
    expect(
      validationState(
        { ...view, workspace: { ...view.workspace!, baseChanged: true } },
        ready
      ).validated
    ).toBe(true);
  });
  test("only complete text in a working copy is editable", () => {
    expect(editorDisabled(view, true, false)).toBe(false);
    for (const modified of [
      { ...view, binary: true },
      { ...view, truncated: true },
      { ...view, content: null },
      { ...view, workspace: undefined },
      { ...view, version: "source" as const },
    ])
      expect(editorDisabled(modified, true, false)).toBe(true);
    expect(editorDisabled(view, false, false)).toBe(true);
    expect(editorDisabled(view, true, true)).toBe(true);
  });
  test("authored and sourceless untracked skills stay view-only", () => {
    expect(isForkableSkill(undefined)).toBe(false);
    for (const kind of ["custom", "draft"] as const)
      expect(isForkableSkill({ ...view, kind })).toBe(false);
    for (const kind of ["external", "vendor"] as const)
      expect(isForkableSkill({ ...view, kind })).toBe(true);
    const untracked = {
      ...view,
      kind: "untracked" as const,
      ref: { name: "example" },
    };
    expect(isForkableSkill(untracked)).toBe(false);
    expect(isForkableSkill(untracked, "owner/repo")).toBe(true);
    expect(isForkableSkill({ ...untracked, ref: view.ref })).toBe(true);
  });
  test("loading Codex locks existing work, while an unsaved edit only blocks operations", () => {
    const idle = {
      active: false,
      busy: false,
      hasWork: true,
      codexLoading: false,
      codexFetching: false,
      editable: true,
      unsaved: false,
    };
    expect(workspaceLocks(idle)).toEqual({
      locked: false,
      upstreamDisabled: false,
      workDisabled: false,
      changesDisabled: false,
      reconnectDisabled: false,
    });
    for (const key of ["active", "busy", "codexLoading"] as const)
      expect(workspaceLocks({ ...idle, [key]: true }).locked).toBe(true);
    expect(workspaceLocks({ ...idle, unsaved: true })).toEqual({
      locked: false,
      upstreamDisabled: true,
      workDisabled: true,
      changesDisabled: true,
      reconnectDisabled: false,
    });
    expect(
      workspaceLocks({ ...idle, hasWork: false, codexLoading: true }).locked
    ).toBe(false);
    for (const state of [
      { ...idle, busy: true },
      { ...idle, codexFetching: true },
      { ...idle, hasWork: false },
    ])
      expect(workspaceLocks(state).reconnectDisabled).toBe(true);
    expect(workspaceLocks({ ...idle, editable: false }).upstreamDisabled).toBe(
      true
    );
  });
});

test("upstream errors never display a known lag, and merges require an available latest version", () => {
  const baseline = { commit: "base", date: "today" };
  const latest = { commit: "latest", date: "today" };
  for (const state of [
    "unchecked",
    "missing",
    "unavailable",
    "review",
    "unknown",
  ] as const) {
    expect(
      upstreamState({ state, baseline, latest, behind: 0 }, false, true).behind
    ).toBe(null);
  }
  const behind = { state: "behind" as const, baseline, latest, behind: 2 };
  expect(upstreamState(behind, false, true)).toEqual({
    blocked: false,
    behind: 2,
    mergeDisabled: false,
  });
  expect(
    upstreamState({ ...behind, state: "current", behind: 0 }, false, true)
      .mergeDisabled
  ).toBe(true);
  expect(
    upstreamState({ ...behind, baseline: undefined }, false, true).behind
  ).toBe(null);
  expect(
    upstreamState({ ...behind, latest: undefined }, false, true).mergeDisabled
  ).toBe(true);
  expect(upstreamState(behind, true, true).mergeDisabled).toBe(true);
  expect(upstreamState(behind, false, false).mergeDisabled).toBe(true);
});

test("保存後は同じファイルの編集を続け、保存した内容と版を基準にする", () => {
  const editor = {
    path: "SKILL.md",
    content: "# Edited",
    original: "# Example",
    revision: "before",
  };
  const saved = { ...view, content: "# Edited", revision: "after" };
  expect(editorAfterSave(editor, saved)).toEqual({
    path: "SKILL.md",
    content: "# Edited",
    original: "# Edited",
    revision: "after",
  });
  expect(editorAfterSave(null, saved)).toBeNull();
  expect(
    editorAfterSave(editor, { ...saved, selectedFile: "other.md" })
  ).toBeNull();
  expect(editorAfterSave(editor, { ...saved, truncated: true })).toBeNull();
  expect(editorAfterSave(editor, { ...saved, content: null })).toBeNull();
});
