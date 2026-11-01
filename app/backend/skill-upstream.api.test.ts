import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { SkillRef, SkillView } from "../shared/skill-workspace-types";
import { createSkillRoutes } from "./skillRoutes";
import {
  checkSkillUpstream,
  fetchSkillSnapshot,
  readCachedSkillSnapshot,
} from "./infrastructure/skill-upstream";

let sandbox: string;
let repo: string;
let catalog: string;
let app: Hono;
let initialCommit: string;
const previousEnv = new Map<string, string | undefined>();
const ref: SkillRef = { name: "alpha", source: "owner/repo" };
const raw = "---\nname: alpha\ndescription: [broken: yaml\n---\n# Alpha\n";

function env(name: string, value: string): void {
  if (!previousEnv.has(name)) previousEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args],
    {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function put(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(message: string): string {
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

async function view(version = "source", file = "SKILL.md"): Promise<SkillView> {
  const query = new URLSearchParams({ ...ref, version, file });
  const response = await app.request(`/api/skill?${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<SkillView>;
}

async function post(
  action: string,
  selected: SkillRef = ref,
  body: Record<string, unknown> = {}
): Promise<SkillView> {
  const response = await app.request(`/api/skill/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: selected, ...body }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<SkillView>;
}

async function save(
  path: string,
  content: string,
  revision: string
): Promise<SkillView> {
  const response = await app.request("/api/skill/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, path, content, revision }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<SkillView>;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "skill-upstream-api-"));
  repo = join(sandbox, "source");
  catalog = join(sandbox, "catalog");
  mkdirSync(repo);
  mkdirSync(catalog);
  const trash = join(sandbox, "trash");
  mkdirSync(trash);
  const trashScript = join(sandbox, "trash-bin");
  writeFileSync(
    trashScript,
    `#!/bin/sh\nfor target in "$@"; do\n  if [ -e "$target" ] || [ -L "$target" ]; then\n    slot="$(mktemp -d '${trash}/item.XXXXXX')" || exit 1\n    mv "$target" "$slot/content" || exit 1\n  fi\ndone\n`
  );
  chmodSync(trashScript, 0o755);
  env("MY_SKILLS_TRASH_BIN", trashScript);
  env("MY_SKILLS_CATALOG_DIR", catalog);
  env("MY_SKILLS_CATALOG_EXPLICIT", "1");
  for (const [key, path] of Object.entries({
    ACTIVE_DIR: "active",
    ARCHIVE_DIR: "archive",
    CLAUDE_SKILLS_DIR: "claude",
    GEMINI_SKILLS_DIR: "gemini",
    PRESETS_DIR: "presets",
    PROJECT_DECKS_DIR: "decks",
    GLOBAL_LOCK_FILE: "global-lock.json",
    LOCK_FILE: "skills.lock.json",
    IGNORE_FILE: "ignore.json",
  }))
    env(`MY_SKILLS_${key}`, join(catalog, path));
  env("MY_SKILLS_AUTO_COMMIT", "0");
  const mapping = join(sandbox, "source-repos.json");
  writeFileSync(mapping, JSON.stringify({ "owner/repo": repo }));
  env("MY_SKILLS_SOURCE_REPOS_FILE", mapping);
  writeFileSync(
    join(catalog, "skills.lock.json"),
    JSON.stringify({
      version: 1,
      custom: { repo: "owner/catalog", skills: {} },
      external: {},
      vendor: {},
    })
  );
  writeFileSync(join(catalog, "global-lock.json"), '{"skills":{}}');
  git("init", "-q", "-b", "main");
  put("skills/alpha/SKILL.md", raw);
  put("skills/alpha/references/details.txt", "original details\n");
  put("skills/beta/SKILL.md", "---\nname: beta\n---\nBeta\n");
  initialCommit = commit("baseline");
  app = new Hono().route("/api/skill", createSkillRoutes());
});

afterEach(() => {
  for (const [key, previous] of previousEnv) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
  Bun.spawnSync(["/usr/bin/trash", sandbox], { stderr: "pipe" });
});

describe("skill upstream HTTP seam (local Git, isolated Catalog)", () => {
  test("discovers malformed YAML by name, views attachments and forks raw content", async () => {
    const source = await view();
    expect(source.ref).toMatchObject({
      ...ref,
      skillPath: "skills/alpha/SKILL.md",
    });
    expect(source.version).toBe("source");
    expect(source.content).toBe(raw);
    expect(source.files.map((file) => file.path)).toContain(
      "references/details.txt"
    );
    expect((await view("source", "references/details.txt")).content).toBe(
      "original details\n"
    );
    const fork = await post("fork");
    expect(fork.version).toBe("work");
    expect(fork.content).toBe(raw);
    expect(fork.upstream.baseline?.commit).toBe(initialCommit);
    expect((await post("fork")).revision).toBe(fork.revision);
    expect(
      JSON.parse(readFileSync(join(catalog, "skills.lock.json"), "utf8")).vendor
    ).toEqual({});
  });

  test("an unmanaged name collision keeps the requested source distinct from the installed copy", async () => {
    const installed = join(catalog, "active/alpha/SKILL.md");
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, "Unmanaged installed copy\n");
    expect((await view()).content).toBe(raw);
    expect((await view("installed")).content).toBe(
      "Unmanaged installed copy\n"
    );
    expect((await post("fork")).content).toBe(raw);
    expect(readFileSync(installed, "utf8")).toBe("Unmanaged installed copy\n");
  });

  test("counts only commits touching this skill directory, including attachments", async () => {
    await post("fork");
    put("skills/beta/notes.txt", "unrelated\n");
    commit("other skill");
    put("skills/alpha/references/details.txt", "updated details\n");
    commit("attachment change");
    put("skills/alpha/SKILL.md", `${raw}Updated\n`);
    const latest = commit("skill change");
    const checked = await post("check-upstream");
    expect(checked.upstream).toMatchObject({
      state: "behind",
      behind: 2,
      baseline: { commit: initialCommit },
      latest: { commit: latest },
    });
    expect(Number.isNaN(Date.parse(checked.upstream.checkedAt ?? ""))).toBe(
      false
    );
    expect((await view()).content).toBe(raw);
    expect((await view("upstream")).content).toBe(`${raw}Updated\n`);
    expect((await view()).upstream).toEqual(checked.upstream);
  });

  test("unrelated commits leave scoped lag zero", async () => {
    await post("fork");
    put("skills/beta/notes.txt", "unrelated\n");
    commit("other skill only");
    expect((await post("check-upstream")).upstream).toMatchObject({
      state: "current",
      behind: 0,
    });
  });

  test("an inaccessible repository is unavailable and cached content remains usable", async () => {
    await post("fork");
    const last = await post("check-upstream");
    renameSync(repo, `${repo}-offline`);
    const checked = await post("check-upstream");
    expect(checked.upstream.state).toBe("unavailable");
    expect(checked.upstream.behind).toBeNull();
    expect(checked.upstream.latest).toEqual(last.upstream.latest);
    expect((await view()).content).toBe(raw);
    expect((await view("work")).content).toBe(raw);
  });

  test("a removed known path is missing and never silently follows the same name", async () => {
    await post("fork");
    git("mv", "skills/alpha", "skills/relocated");
    commit("move skill");
    const checked = await post("check-upstream");
    expect(["missing", "review"]).toContain(checked.upstream.state);
    expect(checked.upstream.behind).toBeNull();
    expect(checked.ref.skillPath).toBe("skills/alpha/SKILL.md");
    expect((await view()).content).toBe(raw);
  });

  test("a missing path in an accessible repository is missing", async () => {
    await post("fork");
    git("rm", "-r", "skills/alpha");
    commit("remove skill");
    expect((await post("check-upstream")).upstream).toMatchObject({
      state: "missing",
      behind: null,
    });
    expect((await view("work")).content).toBe(raw);
  });

  test("an existing external skill without a baseline reports unknown", async () => {
    mkdirSync(join(catalog, "external/alpha"), { recursive: true });
    writeFileSync(join(catalog, "external/alpha/SKILL.md"), raw);
    writeFileSync(
      join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo.git",
            skillPath: "skills/alpha/SKILL.md",
            localRepoPath: "external/alpha",
          },
        },
      })
    );
    expect((await post("check-upstream")).upstream).toMatchObject({
      state: "unknown",
      behind: null,
    });
  });

  test("rewritten history requires review rather than reporting zero lag", async () => {
    await post("fork");
    git("checkout", "--orphan", "replacement");
    put("skills/alpha/SKILL.md", `${raw}Replacement\n`);
    commit("unrelated root history");
    git("branch", "-M", "main");
    expect((await post("check-upstream")).upstream).toMatchObject({
      state: "review",
      behind: null,
    });
  });

  test("source symlink blobs cannot be forked or copied into snapshots", async () => {
    symlinkSync(
      "../../beta/SKILL.md",
      join(repo, "skills/alpha/references/link")
    );
    commit("unsafe symlink");
    const response = await app.request("/api/skill/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(catalog, "vendor/alpha"))).toBe(false);
  });

  test("HTTP never accepts repository paths or traversing skill paths", async () => {
    for (const selected of [
      { name: "alpha", source: repo },
      { ...ref, skillPath: "../alpha/SKILL.md" },
      { ...ref, skillPath: "/skills/alpha/SKILL.md" },
    ]) {
      const response = await app.request(
        `/api/skill?${new URLSearchParams(selected)}`
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("upstream workspace integration", () => {
  test.each([false, true])(
    "source reconciliation preserves work and rolls back metadata failures (%s)",
    async (failMetadata) => {
      const source = join(catalog, "vendor/alpha");
      mkdirSync(join(source, "references"), { recursive: true });
      writeFileSync(join(source, "SKILL.md"), raw);
      writeFileSync(
        join(source, "references/details.txt"),
        "original details\n"
      );
      writeFileSync(
        join(catalog, "skills.lock.json"),
        JSON.stringify({
          version: 1,
          custom: { repo: "owner/catalog", skills: {} },
          external: {},
          vendor: {
            alpha: { source: "owner/repo", skillPath: "skills/alpha/SKILL.md" },
          },
        })
      );
      const fork = await post("fork");
      const ours = `${raw}Retained work\n`;
      const edited = await save("SKILL.md", ours, fork.revision);
      writeFileSync(
        join(source, "references/details.txt"),
        "new canonical detail\n"
      );
      const metadataPath = join(
        catalog,
        ".skill-loom/workspaces/alpha/workspace.json"
      );
      const before = readFileSync(metadataPath, "utf8");
      const { reconcileSkillSource } = await import("./domain/skill-workspace");
      if (failMetadata) {
        const untouched = join(sandbox, "metadata-target");
        writeFileSync(untouched, "protected");
        symlinkSync(untouched, `${metadataPath}.tmp`);
        await expect(
          reconcileSkillSource(ref, edited.revision)
        ).rejects.toThrow();
        expect(readFileSync(metadataPath, "utf8")).toBe(before);
        expect((await view("work", "references/details.txt")).content).toBe(
          "original details\n"
        );
        expect((await view("work")).workspace?.baseChanged).toBe(true);
        expect(readFileSync(untouched, "utf8")).toBe("protected");
      } else {
        const reconciled = await reconcileSkillSource(ref, edited.revision);
        expect(reconciled.workspace?.baseChanged).toBe(false);
        expect((await view("work", "references/details.txt")).content).toBe(
          "new canonical detail\n"
        );
      }
      expect((await view("work")).content).toBe(ours);
      expect(readFileSync(join(source, "references/details.txt"), "utf8")).toBe(
        "new canonical detail\n"
      );
    }
  );

  test("applying pending B after checking C retains C and the remaining scoped lag", async () => {
    const fork = await post("fork");
    await save(
      "SKILL.md",
      raw.replace("[broken: yaml", '"Valid fixture"'),
      fork.revision
    );
    put("skills/alpha/references/details.txt", "pending B\n");
    const pending = commit("pending B");
    await post("merge-upstream");
    put("skills/alpha/references/details.txt", "latest C\n");
    const latest = commit("latest C");
    const checked = await post("check-upstream");
    expect(checked.upstream.latest?.commit).toBe(latest);
    const applied = await post("apply", ref, { revision: checked.revision });
    expect(applied.upstream).toMatchObject({
      state: "behind",
      behind: 1,
      baseline: { commit: pending },
      latest: { commit: latest },
    });
    expect(
      readFileSync(
        join(catalog, "upstream/alpha/references/details.txt"),
        "utf8"
      )
    ).toBe("pending B\n");
    expect((await view("upstream", "references/details.txt")).content).toBe(
      "latest C\n"
    );
  });

  test("choosing work restores pre-merge text instead of keeping conflict markers", async () => {
    const fork = await post("fork");
    const ours = `${raw}Keep my local line\n`;
    await save("SKILL.md", ours, fork.revision);
    put("skills/alpha/SKILL.md", `${raw}Incoming conflicting line\n`);
    commit("conflicting text");
    const merged = await post("merge-upstream");
    expect(merged.content).toContain("<<<<<<<");
    const resolved = await post("resolve-conflict", ref, {
      path: "SKILL.md",
      choice: "work",
      revision: merged.revision,
    });
    expect(resolved.content).toBe(ours);
    expect(resolved.workspace?.conflicts).toEqual([]);
    expect(resolved.content).not.toContain("<<<<<<<");
  });

  test("a failed upstream check preserves the last successful timestamp and version", async () => {
    await post("fork");
    const successful = await post("check-upstream");
    const trackingPath = join(catalog, ".skill-loom/tracking/alpha.json");
    const tracking = JSON.parse(readFileSync(trackingPath, "utf8"));
    const previous = "2020-01-01T00:00:00.000Z";
    tracking.status.checkedAt = previous;
    writeFileSync(trackingPath, JSON.stringify(tracking));
    renameSync(repo, `${repo}-offline`);
    const failed = await post("check-upstream");
    expect(failed.upstream.state).toBe("unavailable");
    expect(failed.upstream.checkedAt).toBe(previous);
    expect(failed.upstream.latest).toEqual(successful.upstream.latest);
    expect(failed.upstream).toHaveProperty("attemptedAt");
    const saved = JSON.parse(readFileSync(trackingPath, "utf8"));
    expect(Date.parse(saved.status.attemptedAt)).toBeGreaterThan(
      Date.parse(previous)
    );
    renameSync(`${repo}-offline`, repo);
    const retried = await post("check-upstream");
    expect(retried.upstream.checkedAt).not.toBe(previous);
    git("checkout", "--orphan", "new-history");
    put("skills/alpha/SKILL.md", `${raw}Rewritten history\n`);
    commit("new root");
    git("branch", "-M", "main");
    const review = await post("check-upstream");
    expect(review.upstream.state).toBe("review");
    expect(review.upstream.checkedAt).toBe(retried.upstream.checkedAt);
    expect(review.upstream.latest).toEqual(retried.upstream.latest);
  });

  test("upstream comparison explicitly reports an unknown baseline", async () => {
    const local = join(catalog, "external/alpha");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "SKILL.md"), `${raw}Existing customization\n`);
    writeFileSync(
      join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo.git",
            localRepoPath: "external/alpha",
            skillPath: "skills/alpha/SKILL.md",
          },
        },
      })
    );
    await post("check-upstream");
    expect((await view("upstream")).diff).toContain(
      "Comparison unavailable: baseline unknown"
    );
    mkdirSync(join(catalog, "upstream/alpha"), { recursive: true });
    writeFileSync(join(catalog, "upstream/alpha/SKILL.md"), raw);
    expect((await view("upstream")).diff).toContain(
      "Comparison unavailable: baseline unknown"
    );
  });

  test("explicit source reconciliation preserves edits and rejects an unreviewed revision", async () => {
    const local = join(catalog, "external/alpha");
    mkdirSync(join(local, "references"), { recursive: true });
    writeFileSync(join(local, "SKILL.md"), raw);
    writeFileSync(join(local, "references/details.txt"), "original details\n");
    writeFileSync(
      join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo.git",
            localRepoPath: "external/alpha",
            skillPath: "skills/alpha/SKILL.md",
          },
        },
      })
    );
    const fork = await post("fork");
    const ours = `${raw}My work survives\n`;
    const edited = await save("SKILL.md", ours, fork.revision);
    writeFileSync(
      join(local, "references/details.txt"),
      "current source detail\n"
    );
    expect((await view("work")).workspace?.baseChanged).toBe(true);
    const stale = await app.request("/api/skill/reconcile-source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, revision: fork.revision }),
    });
    expect(stale.status).toBe(409);
    expect((await view("work")).workspace?.baseChanged).toBe(true);
    const reconciled = await post("reconcile-source", ref, {
      revision: edited.revision,
    });
    expect(reconciled.content).toBe(ours);
    expect(reconciled.workspace?.baseChanged).toBe(false);
    expect(reconciled.workspace?.conflicts).toEqual([]);
    expect((await view("work", "references/details.txt")).content).toBe(
      "current source detail\n"
    );
    const metadata = JSON.parse(
      readFileSync(
        join(catalog, ".skill-loom/workspaces/alpha/workspace.json"),
        "utf8"
      )
    );
    expect(metadata.baseline).toBeUndefined();
    expect(metadata.pending).toBeUndefined();
    expect(readFileSync(join(local, "SKILL.md"), "utf8")).toBe(raw);
  });

  test("source reconciliation conflicts can keep the exact pre-reconcile work", async () => {
    const local = join(catalog, "external/alpha");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "SKILL.md"), raw);
    writeFileSync(
      join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo.git",
            localRepoPath: "external/alpha",
            skillPath: "skills/alpha/SKILL.md",
          },
        },
      })
    );
    const fork = await post("fork");
    const ours = `${raw}My source conflict choice\n`;
    const edited = await save("SKILL.md", ours, fork.revision);
    writeFileSync(join(local, "SKILL.md"), `${raw}Other source edit\n`);
    const merged = await post("reconcile-source", ref, {
      revision: edited.revision,
    });
    expect(merged.workspace?.conflicts).toEqual(["SKILL.md"]);
    expect(merged.content).toContain("Other source edit");
    const resolved = await post("resolve-conflict", ref, {
      path: "SKILL.md",
      choice: "work",
      revision: merged.revision,
    });
    expect(resolved.content).toBe(ours);
    expect(resolved.workspace?.baseChanged).toBe(false);
    expect(resolved.workspace?.conflicts).toEqual([]);
  });

  test("an upstream executable-bit change reaches the working copy", async () => {
    put("skills/alpha/scripts/run.sh", "echo fixture\n");
    commit("nonexecutable script baseline");
    await post("fork");
    chmodSync(join(repo, "skills/alpha/scripts/run.sh"), 0o755);
    commit("make script executable");
    await post("merge-upstream");
    const { statSync } = await import("node:fs");
    expect(
      statSync(
        join(catalog, ".skill-loom/workspaces/alpha/files/scripts/run.sh")
      ).mode & 0o111
    ).toBe(0o111);
  });

  test("unknown add/delete/binary conflicts can be resolved explicitly without Codex", async () => {
    put("skills/alpha/assets/data.bin", "\0upstream");
    put("skills/alpha/new.txt", "new upstream file\n");
    commit("incoming files");
    const localRoot = join(catalog, "external/alpha");
    mkdirSync(join(localRoot, "assets"), { recursive: true });
    mkdirSync(join(localRoot, "references"), { recursive: true });
    writeFileSync(
      join(localRoot, "references/details.txt"),
      "original details\n"
    );
    writeFileSync(join(localRoot, "SKILL.md"), raw);
    writeFileSync(join(localRoot, "assets/data.bin"), "\0local");
    writeFileSync(
      join(localRoot, "local-only.txt"),
      "preserve until explicit deletion\n"
    );
    writeFileSync(
      join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo.git",
            skillPath: "skills/alpha/SKILL.md",
            localRepoPath: "external/alpha",
          },
        },
      })
    );
    await post("fork");
    let current = await post("merge-upstream");
    expect(current.workspace?.conflicts).toEqual([
      "assets/data.bin",
      "local-only.txt",
      "new.txt",
    ]);
    for (const [path, choice] of [
      ["new.txt", "upstream"],
      ["assets/data.bin", "work"],
      ["local-only.txt", "upstream"],
    ]) {
      const response = await app.request("/api/skill/resolve-conflict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, path, choice, revision: current.revision }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      current = (await response.json()) as SkillView;
    }
    expect(current.workspace?.conflicts).toEqual([]);
    expect((await view("work", "new.txt")).content).toBe("new upstream file\n");
    expect(
      readFileSync(
        join(catalog, ".skill-loom/workspaces/alpha/files/assets/data.bin")
      ).toString()
    ).toBe("\0local");
    expect(
      existsSync(
        join(catalog, ".skill-loom/workspaces/alpha/files/local-only.txt")
      )
    ).toBe(false);
    expect(readFileSync(join(localRoot, "local-only.txt"), "utf8")).toContain(
      "preserve"
    );
  });

  test("merges the whole tree, retains customization and defers the baseline", async () => {
    const fork = await post("fork");
    const customized = `${raw}My customization\n`;
    await save("SKILL.md", customized, fork.revision);
    put("skills/alpha/references/details.txt", "upstream details\n");
    put("skills/alpha/assets/new.txt", "new asset\n");
    const latest = commit("full tree update");
    const merged = await post("merge-upstream");
    expect(merged.content).toBe(customized);
    expect(merged.workspace?.conflicts).toEqual([]);
    expect((await view("work", "references/details.txt")).content).toBe(
      "upstream details\n"
    );
    expect((await view("work", "assets/new.txt")).content).toBe("new asset\n");
    const metadata = JSON.parse(
      readFileSync(
        join(catalog, ".skill-loom/workspaces/alpha/workspace.json"),
        "utf8"
      )
    );
    expect(metadata.baseline.commit).toBe(initialCommit);
    expect(metadata.pending.commit).toBe(latest);
    expect(
      readFileSync(
        join(catalog, ".skill-loom/workspaces/alpha/pending-upstream/SKILL.md"),
        "utf8"
      )
    ).toBe(raw);
    expect((await view()).content).toBe(raw);
    expect((await view()).upstream.baseline?.commit).toBe(initialCommit);
    const upstream = await view("upstream");
    expect(upstream.diff).toContain("upstream details");
    expect(upstream.diff).not.toContain("My customization");
  });

  test("text conflicts retain both local and incoming edits", async () => {
    const fork = await post("fork");
    await save("SKILL.md", `${raw}Local line\n`, fork.revision);
    put("skills/alpha/SKILL.md", `${raw}Incoming line\n`);
    commit("conflicting update");
    const merged = await post("merge-upstream");
    expect(merged.workspace?.conflicts).toContain("SKILL.md");
    expect(merged.content).toContain("Local line");
    expect(merged.content).toContain("Incoming line");
    expect(merged.content).toContain("<<<<<<<");
    expect((await view()).content).toBe(raw);
  });

  test("unknown baselines preserve work and require explicit reconciliation", async () => {
    mkdirSync(join(catalog, "external/alpha"), { recursive: true });
    const local = `${raw}Existing customization\n`;
    writeFileSync(join(catalog, "external/alpha/SKILL.md"), local);
    writeFileSync(
      join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        vendor: {},
        external: {
          alpha: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo.git",
            skillPath: "skills/alpha/SKILL.md",
            localRepoPath: "external/alpha",
          },
        },
      })
    );
    await post("fork");
    const merged = await post("merge-upstream");
    expect(merged.content).toBe(local);
    expect(merged.workspace?.conflicts).toContain("SKILL.md");
    expect(merged.upstream.baseline).toBeUndefined();
    expect(merged.upstream.behind).toBeNull();
    const metadata = JSON.parse(
      readFileSync(
        join(catalog, ".skill-loom/workspaces/alpha/workspace.json"),
        "utf8"
      )
    );
    expect(metadata.baseline).toBeUndefined();
    expect(metadata.pending.commit).toBe(initialCommit);
  });

  test("discard preserves the source and a new fork starts from it", async () => {
    const fork = await post("fork");
    await save("SKILL.md", `${raw}Discard me\n`, fork.revision);
    const discarded = await post("discard");
    expect(discarded.version).toBe("source");
    expect(discarded.content).toBe(raw);
    expect(discarded.workspace).toBeUndefined();
    expect((await post("fork")).content).toBe(raw);
  });

  test("a predictable .tmp symlink never overwrites its target", async () => {
    const fork = await post("fork");
    const outside = join(sandbox, "must-not-change");
    writeFileSync(outside, "protected");
    symlinkSync(
      outside,
      join(catalog, ".skill-loom/workspaces/alpha/files/SKILL.md.tmp")
    );
    const response = await app.request("/api/skill/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref,
        path: "SKILL.md",
        content: `${raw}Saved\n`,
        revision: fork.revision,
      }),
    });
    expect(response.status).toBe(400);
    expect(readFileSync(outside, "utf8")).toBe("protected");
  });

  test("an unfinished apply journal is visible on the skill view", async () => {
    await post("fork");
    mkdirSync(join(catalog, ".skill-loom/transactions/alpha"), {
      recursive: true,
    });
    writeFileSync(
      join(catalog, ".skill-loom/transactions/alpha/journal.json"),
      "{}"
    );
    expect((await view()).message).toContain("適用の復旧が必要です");
  });

  test("workspace directory symlinks cannot redirect reads outside the Catalog", async () => {
    await post("fork");
    const files = join(catalog, ".skill-loom/workspaces/alpha/files");
    renameSync(files, join(sandbox, "moved-work"));
    const outside = join(sandbox, "outside-skill");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "private outside content");
    symlinkSync(outside, files);
    expect(
      (
        await app.request(
          `/api/skill?${new URLSearchParams({ ...ref, version: "work" })}`
        )
      ).status
    ).toBe(400);
  });
});

describe("snapshot storage boundaries", () => {
  test("cached upstream checks recompute lag without fetching a newer or unavailable source", async () => {
    await fetchSkillSnapshot(ref);
    put("skills/alpha/references/details.txt", "baseline B\n");
    commit("baseline B");
    const baseline = await fetchSkillSnapshot(ref, true);
    put("skills/alpha/references/details.txt", "cached C\n");
    const cachedCommit = commit("cached C");
    await checkSkillUpstream(ref, baseline.version);
    put("skills/alpha/references/details.txt", "unfetched D\n");
    commit("unfetched D");
    renameSync(repo, `${repo}-offline`);
    expect(
      await checkSkillUpstream(ref, baseline.version, false)
    ).toMatchObject({
      state: "behind",
      behind: 1,
      latest: { commit: cachedCommit },
    });
    expect(readCachedSkillSnapshot(ref)?.version.commit).toBe(cachedCommit);
  });

  test("a cached-only check without a snapshot returns unknown and never fetches", async () => {
    const status = await checkSkillUpstream(ref, undefined, false);
    expect(status).toMatchObject({ state: "unknown", behind: null });
    expect(status.latest).toBeUndefined();
    expect(readCachedSkillSnapshot(ref)).toBeNull();
  });

  test("scoped history excludes unrelated commits and detects nonancestor baselines", async () => {
    const original = await fetchSkillSnapshot(ref);
    put("skills/beta/notes.txt", "other skill\n");
    commit("unrelated");
    expect(await checkSkillUpstream(ref, original.version)).toMatchObject({
      state: "current",
      behind: 0,
    });
    put("skills/alpha/references/details.txt", "new reference\n");
    commit("reference");
    put("skills/alpha/SKILL.md", `${raw}Changed\n`);
    const latest = commit("body");
    expect(await checkSkillUpstream(ref, original.version)).toMatchObject({
      state: "behind",
      behind: 2,
      latest: { commit: latest },
    });
    git("checkout", "--orphan", "rewritten");
    put("skills/alpha/SKILL.md", `${raw}New history\n`);
    commit("new root");
    git("branch", "-M", "main");
    expect(await checkSkillUpstream(ref, original.version)).toMatchObject({
      state: "review",
      behind: null,
    });
  });

  test("snapshots are immutable copies without Git metadata and cache reads work offline", async () => {
    const original = await fetchSkillSnapshot(ref);
    expect(original.ref.skillPath).toBe("skills/alpha/SKILL.md");
    expect(readFileSync(join(original.root, "SKILL.md"), "utf8")).toBe(raw);
    expect(existsSync(join(original.root, ".git"))).toBe(false);
    put("skills/alpha/SKILL.md", `${raw}changed\n`);
    commit("new snapshot");
    expect(readCachedSkillSnapshot(ref)?.version.commit).toBe(initialCommit);
    const updated = await fetchSkillSnapshot(ref, true);
    expect(updated.root).not.toBe(original.root);
    expect(readFileSync(join(original.root, "SKILL.md"), "utf8")).toBe(raw);
    renameSync(repo, `${repo}-offline`);
    expect((await fetchSkillSnapshot(ref)).version).toEqual(updated.version);
  });

  test("an unresolvable baseline is unknown, never zero lag", async () => {
    const baseline = { commit: "f".repeat(40), date: "2020-01-01T00:00:00Z" };
    expect(await checkSkillUpstream(ref, baseline)).toMatchObject({
      state: "unknown",
      baseline,
      behind: null,
    });
  });

  test("cached discovery pins the path even when subsequent callers omit it", async () => {
    const original = await fetchSkillSnapshot(ref);
    git("mv", "skills/alpha", "skills/renamed");
    commit("moved");
    await expect(fetchSkillSnapshot(ref, true)).rejects.toMatchObject({
      state: "missing",
    });
    expect(readCachedSkillSnapshot(ref)?.root).toBe(original.root);
  });

  test("source submodule entries are rejected without being checked out", async () => {
    git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${initialCommit},skills/alpha/nested`
    );
    git("commit", "-qm", "gitlink");
    await expect(fetchSkillSnapshot(ref)).rejects.toMatchObject({
      state: "review",
    });
    expect(readCachedSkillSnapshot(ref)).toBeNull();
  });

  test("per-file and file-count limits reject before publishing snapshots", async () => {
    put("skills/alpha/large.bin", "x".repeat(8 * 1024 * 1024 + 1));
    commit("large blob");
    await expect(fetchSkillSnapshot(ref)).rejects.toMatchObject({
      state: "review",
    });
    expect(readCachedSkillSnapshot(ref)).toBeNull();
    git("rm", "skills/alpha/large.bin");
    for (let index = 0; index < 2000; index++)
      put(`skills/alpha/many/${index}.txt`, "x");
    commit("too many files");
    await expect(fetchSkillSnapshot(ref)).rejects.toMatchObject({
      state: "review",
    });
    expect(readCachedSkillSnapshot(ref)).toBeNull();
  });

  test("Git object storage symlinks cannot redirect writes outside the Catalog", async () => {
    const original = await fetchSkillSnapshot(ref);
    const cacheRepo = join(
      dirname(dirname(dirname(original.root))),
      "repo.git"
    );
    const outside = join(sandbox, "outside-objects");
    renameSync(join(cacheRepo, "objects"), outside);
    symlinkSync(outside, join(cacheRepo, "objects"));
    await expect(fetchSkillSnapshot(ref, true)).rejects.toThrow();
  });

  test("an interrupted or modified existing snapshot is never silently reused", async () => {
    const original = await fetchSkillSnapshot(ref);
    const path = join(original.root, "references/details.txt");
    chmodSync(path, 0o644);
    writeFileSync(path, "partial");
    await expect(fetchSkillSnapshot(ref, true)).rejects.toMatchObject({
      state: "review",
    });
  });

  test("unsafe upstream filenames report review without publishing a snapshot", async () => {
    put("skills/alpha/unsafe\\file", "unsafe");
    commit("unsafe filename");
    expect(await checkSkillUpstream(ref)).toMatchObject({
      state: "review",
      behind: null,
    });
    expect(readCachedSkillSnapshot(ref)).toBeNull();
  });

  test("configured fixture mapping never falls through to the internet", async () => {
    await expect(
      fetchSkillSnapshot({ name: "alpha", source: "other/repo" })
    ).rejects.toMatchObject({ state: "unavailable" });
  });
});
