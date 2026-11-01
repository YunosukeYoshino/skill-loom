import { expect, test } from "bun:test";
import type {
  ExternalSourceDetailPayload,
  InstalledExternal,
} from "../../../shared/api-types";
import {
  externalGlobalSelection,
  updateExternalGlobal,
  externalSourceActivity,
} from "./external-source-model";

const installed: InstalledExternal[] = ["active", "off", "archive"].map(
  (state, index) => ({
    name: `skill-${index}`,
    description: "example",
    path: "example",
    state: state as InstalledExternal["state"],
    hasUpdate: true,
    updateCommand: "update",
    managed: true,
  })
);

test("external source activity reports the first pending operation in the existing order", () => {
  const idle = {
    updateAll: false,
    updateOne: false,
    remove: false,
    removeSource: false,
    install: false,
    applyGlobal: false,
  };
  expect(externalSourceActivity(idle)).toBeUndefined();
  for (const [operation, message] of [
    ["updateAll", "status.updateSource"],
    ["updateOne", "status.updateSkill"],
    ["remove", "status.removing"],
    ["removeSource", "status.removing"],
    ["install", "status.installing"],
    ["applyGlobal", "status.applyingGlobal"],
  ] as const)
    expect(externalSourceActivity({ ...idle, [operation]: true })).toBe(
      message
    );
  expect(
    externalSourceActivity({
      ...idle,
      updateAll: true,
      remove: true,
      install: true,
    })
  ).toBe("status.updateSource");
  expect(
    externalSourceActivity({ ...idle, removeSource: true, install: true })
  ).toBe("status.removing");
});

test("bulk global changes include only skills whose active state changes", () => {
  expect(externalGlobalSelection(installed, true)).toEqual({
    "skill-1": "active",
    "skill-2": "active",
  });
  expect(externalGlobalSelection(installed, false)).toEqual({
    "skill-0": "off",
  });
  expect(externalGlobalSelection([], true)).toEqual({});
  expect(externalGlobalSelection([installed[0]!], true)).toEqual({});
});

test("optimistic global state preserves unrelated rows and only retains active update indicators", () => {
  const data: ExternalSourceDetailPayload = {
    page: "external-source",
    title: "example",
    message: "old",
    decks: ["deck"],
    source: "owner/repo",
    installed,
    available: [],
    replaceable: [],
    updatable: installed.map((skill) => skill.name),
    removal: { remove: [], keepVendor: [], decks: 1 },
  };
  const next = updateExternalGlobal(data, {
    "skill-0": "off",
    "skill-1": "active",
  });
  expect(next.installed.map((skill) => [skill.state, skill.hasUpdate])).toEqual(
    [
      ["off", false],
      ["active", true],
      ["archive", true],
    ]
  );
  expect(next.updatable).toEqual(["skill-1", "skill-2"]);
  expect(next.message).toBe("");
  expect(next.decks).toBe(data.decks);
  expect(next.installed[2]).toBe(data.installed[2]);
  expect(data.installed[0]!.state).toBe("active");
  expect(data.message).toBe("old");
});
