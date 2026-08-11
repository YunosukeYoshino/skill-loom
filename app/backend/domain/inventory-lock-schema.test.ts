import { describe, expect, test } from "bun:test";
import { parseInventoryLock } from "./inventory-lock-schema";

const emptyLock = {
  version: 1 as const,
  custom: { repo: "owner/catalog", skills: {} },
  external: {},
  vendor: {},
};

describe("parseInventoryLock", () => {
  test("accepts a valid empty version 1 Lock", () => {
    expect(parseInventoryLock(emptyLock)).toEqual(emptyLock);
  });

  test("accepts the current version 1 metadata shape", () => {
    const lock = {
      version: 1 as const,
      custom: {
        repo: "owner/catalog",
        skills: {
          custom: {
            repoPath: "skills/engineering/custom",
            category: "engineering",
          },
        },
      },
      external: {
        external: {
          source: "owner/upstream",
          sourceUrl: "https://github.com/owner/upstream.git",
          skillPath: "skills/external/SKILL.md",
          localRepoPath: "upstream/owner/upstream/skills/external",
          installSkill: "external",
        },
      },
      vendor: { forked: { source: "owner/upstream" } },
    };

    expect(parseInventoryLock(lock)).toEqual(lock);
  });

  test("rejects missing required fields with their JSON path", () => {
    expect(() =>
      parseInventoryLock({ ...emptyLock, custom: undefined })
    ).toThrow("Inventory Lock.custom: is required");
  });

  test("rejects unsupported versions", () => {
    expect(() => parseInventoryLock({ ...emptyLock, version: 2 })).toThrow(
      "Inventory Lock.version: unsupported version 2; expected 1"
    );
  });

  test("rejects invalid metadata types with their JSON path", () => {
    expect(() =>
      parseInventoryLock({
        ...emptyLock,
        custom: {
          ...emptyLock.custom,
          skills: { broken: { repoPath: 42, category: "engineering" } },
        },
      })
    ).toThrow("Inventory Lock.custom.skills.broken.repoPath: expected string");
  });
});
