import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSkillRoutes } from "./skillRoutes";

let root: string;
let app: Hono;
const previous = new Map<string, string | undefined>();
function env(name: string, value: string) {
  previous.set(name, process.env[name]);
  process.env[name] = value;
}
function place(path: string, content: string) {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}
function inventory(external: Record<string, object> = {}) {
  external = Object.fromEntries(
    Object.entries(external).map(([name, meta]) => [
      name,
      { sourceUrl: "https://github.com/owner/repo.git", ...meta },
    ])
  );
  place(
    "skills.lock.json",
    JSON.stringify({
      version: 1,
      custom: {
        repo: "example/catalog",
        skills: {
          alpha: { repoPath: "skills/alpha", category: "engineering" },
        },
      },
      external,
      vendor: {},
    })
  );
}
async function post(action: string, body: object) {
  return app.request(`/api/skill/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-workspace-api-"));
  env("MY_SKILLS_CATALOG_DIR", root);
  env("MY_SKILLS_CATALOG_EXPLICIT", "1");
  for (const [key, path] of Object.entries({
    MY_SKILLS_ACTIVE_DIR: "active",
    MY_SKILLS_ARCHIVE_DIR: "archive",
    MY_SKILLS_CLAUDE_SKILLS_DIR: "claude",
    MY_SKILLS_GEMINI_SKILLS_DIR: "gemini",
    MY_SKILLS_GLOBAL_LOCK_FILE: "cli-lock.json",
  }))
    env(key, join(root, path));
  // テストの回収も復元可能にし、実ユーザーの Trash へ依存しない。
  place(
    "trash-bin",
    '#!/bin/sh\nstash="$(dirname "$0")/trash"\nmkdir -p "$stash"\nfor p in "$@"; do [ ! -e "$p" ] && [ ! -L "$p" ] && continue; mv "$p" "$stash/${p##*/}-$(date +%s)-$$"; done\n'
  );
  Bun.spawnSync(["chmod", "+x", join(root, "trash-bin")]);
  env("MY_SKILLS_TRASH_BIN", join(root, "trash-bin"));
  inventory();
  place(
    "skills/alpha/SKILL.md",
    "---\nname: alpha\ndescription: Example\n---\n# Alpha\n"
  );
  place("skills/alpha/references/help.md", "Useful reference\n");
  app = new Hono().route("/api/skill", createSkillRoutes());
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
  // 一時 Catalog だけをゴミ箱へ回収する。
  Bun.spawnSync(["/usr/bin/trash", root]);
});

test("HTTP で正本と付属ファイルを閲覧でき、利用環境は変更しない", async () => {
  const before = readFileSync(join(root, "skills.lock.json"), "utf8");
  const response = await app.request(
    "/api/skill?name=alpha&file=references%2Fhelp.md"
  );
  expect(response.status).toBe(200);
  const view = await response.json();
  expect(view.kind).toBe("custom");
  expect(view.version).toBe("source");
  expect(view.content).toBe("Useful reference\n");
  expect(view.files.map((file: { path: string }) => file.path)).toEqual([
    "SKILL.md",
    "references/help.md",
  ]);
  expect(readFileSync(join(root, "skills.lock.json"), "utf8")).toBe(before);
});

test("不正な YAML でも Fork を作れ、再開しても原版を変更しない", async () => {
  inventory({
    beta: {
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/beta/SKILL.md",
    },
  });
  const original = "---\nname: beta\ndescription: Bad: YAML\n---\n# Beta\n";
  place("active/beta/SKILL.md", original);
  place("active/beta/scripts/run.sh", "echo original\n");
  const response = await post("fork", { ref: { name: "beta" } });
  expect(response.status).toBe(200);
  const view = await response.json();
  expect(view.version).toBe("work");
  expect(view.workspace.issues.join(" ")).toContain("YAML");
  expect(view.files.map((file: { path: string }) => file.path)).toContain(
    "scripts/run.sh"
  );
  expect(
    (await (await post("fork", { ref: { name: "beta" } })).json()).revision
  ).toBe(view.revision);
  expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toBe(
    original
  );
  expect(
    JSON.parse(readFileSync(join(root, "skills.lock.json"), "utf8")).vendor
  ).toEqual({});
});

test("保存は作業用コピーだけを書き換え、古い編集やスキル外のパスを拒否する", async () => {
  inventory({
    beta: {
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/beta/SKILL.md",
    },
  });
  place(
    "active/beta/SKILL.md",
    "---\nname: beta\ndescription: Original\n---\n# Original\n"
  );
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const content =
    '---\nname: beta\ndescription: "Fixed: YAML"\n---\n# Edited\n';
  const saved = await post("save", {
    ref,
    path: "SKILL.md",
    content,
    revision: fork.revision,
  });
  expect(saved.status).toBe(200);
  const view = await saved.json();
  expect(view.content).toBe(content);
  expect(view.workspace.issues).toEqual([]);
  expect(view.diff).toContain("+# Edited");
  expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toContain(
    "# Original"
  );
  expect(
    (
      await post("save", {
        ref,
        path: "SKILL.md",
        content: "stale",
        revision: fork.revision,
      })
    ).status
  ).toBe(409);
  expect(
    (
      await post("save", {
        ref,
        path: "../../skills.lock.json",
        content: "overwrite",
        revision: view.revision,
      })
    ).status
  ).toBe(400);
  expect(
    (
      await app.request(
        "/api/skill?name=beta&version=work&file=..%2F..%2Fskills.lock.json"
      )
    ).status
  ).toBe(400);
  expect(
    (
      await post("save", {
        ref,
        path: ".GiT/config",
        content: "metadata",
        revision: view.revision,
      })
    ).status
  ).toBe(400);
});

test.each(["active", "archive", "off"])(
  "適用は同名 Vendor に移行し %s と Deck を維持する",
  async (state) => {
    inventory({
      beta: {
        source: "owner/repo",
        sourceUrl: "https://github.com/owner/repo.git",
        skillPath: "skills/beta/SKILL.md",
      },
    });
    const original =
      "---\nname: beta\ndescription: Original\n---\n# Original\n";
    // Off の正本も取得済みスナップショットから扱えるよう、既存 Vendor を使用する。
    if (state === "off") {
      const lock = JSON.parse(
        readFileSync(join(root, "skills.lock.json"), "utf8")
      );
      delete lock.external.beta;
      lock.vendor.beta = {
        source: "owner/repo",
        skillPath: "skills/beta/SKILL.md",
      };
      place("skills.lock.json", JSON.stringify(lock));
      place("vendor/beta/SKILL.md", original);
      place("upstream/beta/SKILL.md", original);
    } else place(`${state}/beta/SKILL.md`, original);
    place("project-decks/demo.json", JSON.stringify({ skills: ["beta"] }));
    const deck = readFileSync(join(root, "project-decks/demo.json"), "utf8");
    const ref = { name: "beta" };
    const fork = await (await post("fork", { ref })).json();
    const content = original.replace("# Original", "# Edited");
    const saved = await (
      await post("save", {
        ref,
        path: "SKILL.md",
        content,
        revision: fork.revision,
      })
    ).json();
    const response = await post("apply", { ref, revision: saved.revision });
    expect(response.status).toBe(200);
    const lock = JSON.parse(
      readFileSync(join(root, "skills.lock.json"), "utf8")
    );
    expect(lock.external.beta).toBeUndefined();
    expect(lock.vendor.beta.source).toBe("owner/repo");
    expect(readFileSync(join(root, "vendor/beta/SKILL.md"), "utf8")).toBe(
      content
    );
    expect(readFileSync(join(root, "upstream/beta/SKILL.md"), "utf8")).toBe(
      original
    );
    expect(readFileSync(join(root, "project-decks/demo.json"), "utf8")).toBe(
      deck
    );
    if (state !== "off")
      expect(readFileSync(join(root, state, "beta/SKILL.md"), "utf8")).toBe(
        content
      );
    const { existsSync } = await import("node:fs");
    if (state !== "active")
      expect(existsSync(join(root, "active/beta"))).toBe(false);
    if (state !== "archive")
      expect(existsSync(join(root, "archive/beta"))).toBe(false);
  }
);

test("他サイトや text/plain の書き込み要求を実行しない", async () => {
  const crossSiteRead = await app.request("/api/skill?name=alpha", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  expect(crossSiteRead.status).toBe(403);
  const response = await app.request("/api/skill/fork", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "https://untrusted.example",
    },
    body: JSON.stringify({ ref: { name: "alpha" } }),
  });
  expect(response.status).toBe(403);
  const plain = await app.request("/api/skill/fork", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
    },
    body: JSON.stringify({ ref: { name: "alpha" } }),
  });
  expect(plain.status).toBe(415);
});

test.each(["localhost", "127.0.0.1", "[::1]", "skill-loom.localhost"])(
  "local host %s accepts same-origin skill reads",
  async (host) => {
    const origin = `http://${host}:9000`;
    const response = await app.request(`${origin}/api/skill?name=alpha`, {
      headers: { origin, "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(200);
  }
);

const untrustedSkillRequests: {
  url: string;
  headers: Record<string, string>;
}[] = [
  { url: "http://localhost.evil.example", headers: {} },
  { url: "http://localhost:9000", headers: { origin: "invalid" } },
  {
    url: "http://localhost:9000",
    headers: { origin: "http://localhost:9001" },
  },
  { url: "http://localhost:9000", headers: { "sec-fetch-site": "same-site" } },
];
test.each(untrustedSkillRequests)(
  "untrusted request is rejected before reading skills: %j",
  async ({ url, headers }) => {
    const response = await app.request(`${url}/api/skill?name=alpha`, {
      headers,
    });
    expect(response.status).toBe(403);
  }
);

test("適用の途中失敗で原版と Inventory を戻し、編集内容から再試行できる", async () => {
  inventory({
    beta: {
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/beta/SKILL.md",
    },
  });
  const original = "---\nname: beta\ndescription: Original\n---\n# Original\n";
  place("active/beta/SKILL.md", original);
  const before = readFileSync(join(root, "skills.lock.json"), "utf8");
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const content = original.replace("# Original", "# Edited");
  const saved = await (
    await post("save", {
      ref,
      path: "SKILL.md",
      content,
      revision: fork.revision,
    })
  ).json();
  place("cli-lock.json", "invalid CLI lock");
  const failed = await post("apply", { ref, revision: saved.revision });
  expect(failed.status).toBe(500);
  expect(
    JSON.parse(readFileSync(join(root, "skills.lock.json"), "utf8"))
  ).toEqual(JSON.parse(before));
  expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toBe(
    original
  );
  const resumed = await (
    await app.request("/api/skill?name=beta&version=work")
  ).json();
  expect(resumed.content).toBe(content);
  expect(resumed.workspace.baseChanged).toBe(false);
  place("cli-lock.json", JSON.stringify({ version: 3, skills: {} }));
  expect(
    (await post("apply", { ref, revision: resumed.revision })).status
  ).toBe(200);
});

test.each(["present", "absent", "removed", "unreadable"])(
  "recovery preserves a different skill (CLI lock: %s)",
  async (cliState) => {
    const { recoverSkillApplications } = await import("./domain/skill-apply");
    inventory({
      beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
      gamma: { source: "owner/repo", skillPath: "skills/gamma/SKILL.md" },
    });
    if (cliState !== "absent")
      place(
        "cli-lock.json",
        JSON.stringify({
          version: 3,
          skills: {
            beta: { source: "owner/repo" },
            gamma: { source: "owner/repo" },
          },
        })
      );
    const revisions: Record<string, string> = {};
    for (const name of ["beta", "gamma"]) {
      const content = `---\nname: ${name}\ndescription: Original\n---\n# Original\n`;
      place(`active/${name}/SKILL.md`, content);
      const ref = { name };
      const fork = await (await post("fork", { ref })).json();
      const saved = await (
        await post("save", {
          ref,
          path: "SKILL.md",
          content: content.replace("# Original", "# Edited"),
          revision: fork.revision,
        })
      ).json();
      revisions[name] = saved.revision;
    }
    place("claude", "Blocks agent-link directory creation\n");
    const failed = await post("apply", {
      ref: { name: "beta" },
      revision: revisions.beta,
    });
    expect(failed.status).toBe(500);
    expect(
      existsSync(join(root, ".skill-loom/transactions/beta/journal.json"))
    ).toBe(true);
    renameSync(join(root, "claude"), join(root, "claude-blocker"));
    expect(
      (
        await post("apply", {
          ref: { name: "gamma" },
          revision: revisions.gamma,
        })
      ).status
    ).toBe(200);
    const lock = readFileSync(join(root, "skills.lock.json"), "utf8");
    if (cliState === "absent")
      place(
        "cli-lock.json",
        JSON.stringify({
          version: 4,
          updatedAt: "retained",
          skills: { delta: { source: "another/repo" } },
        })
      );
    const cli = readFileSync(join(root, "cli-lock.json"), "utf8");
    if (cliState === "removed")
      renameSync(
        join(root, "cli-lock.json"),
        join(root, "removed-cli-lock.json")
      );
    if (cliState === "unreadable") {
      place("cli-lock.json", "unreadable CLI lock");
      expect(recoverSkillApplications().join(" ")).toContain("復旧が必要");
      expect(readFileSync(join(root, "cli-lock.json"), "utf8")).toBe(
        "unreadable CLI lock"
      );
      expect(
        existsSync(join(root, ".skill-loom/transactions/beta/journal.json"))
      ).toBe(true);
      place("cli-lock.json", cli);
    }
    expect(JSON.parse(lock).vendor.gamma).toBeDefined();
    expect(JSON.parse(cli).skills.gamma).toBeUndefined();
    expect(recoverSkillApplications()).toEqual([]);
    expect(readFileSync(join(root, "skills.lock.json"), "utf8")).toBe(lock);
    const restored = JSON.parse(
      readFileSync(join(root, "skills.lock.json"), "utf8")
    );
    expect(restored.external.beta).toEqual({
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/beta/SKILL.md",
    });
    expect(restored.vendor.beta).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(root, "cli-lock.json"), "utf8"))
    ).toEqual(JSON.parse(cli));
    expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toContain(
      "# Original"
    );
    expect(readFileSync(join(root, "active/gamma/SKILL.md"), "utf8")).toContain(
      "# Edited"
    );
    expect(readFileSync(join(root, "vendor/gamma/SKILL.md"), "utf8")).toContain(
      "# Edited"
    );
    expect(existsSync(join(root, ".skill-loom/transactions/beta"))).toBe(false);
    expect(recoverSkillApplications()).toEqual([]);
  }
);

test("構文エラーは保存できるが適用できず、正本の別変更も上書きしない", async () => {
  inventory({
    beta: {
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo.git",
      skillPath: "skills/beta/SKILL.md",
    },
  });
  const original = "---\nname: beta\ndescription: Original\n---\n# Original\n";
  place("active/beta/SKILL.md", original);
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const invalid = await (
    await post("save", {
      ref,
      path: "SKILL.md",
      content: original.replace("Original", "Bad: YAML"),
      revision: fork.revision,
    })
  ).json();
  expect(invalid.workspace.issues.length).toBeGreaterThan(0);
  expect(
    (await post("apply", { ref, revision: invalid.revision })).status
  ).toBe(400);
  const fixed = await (
    await post("save", {
      ref,
      path: "SKILL.md",
      content: original,
      revision: invalid.revision,
    })
  ).json();
  place("active/beta/SKILL.md", original + "\nChanged by another operation\n");
  expect((await post("apply", { ref, revision: fixed.revision })).status).toBe(
    409
  );
  expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toContain(
    "Changed by another operation"
  );
  const reconcile = await post("reconcile-source", {
    ref,
    revision: fixed.revision,
  });
  expect(reconcile.status).toBe(200);
  const reconciled = await reconcile.json();
  expect(reconciled.workspace.baseChanged).toBe(false);
  expect(reconciled.content).toContain("Changed by another operation");
});

test("不正な参照・JSON・版をクライアント入力エラーとして返す", async () => {
  expect(
    (await post("fork", { ref: { name: "beta", source: {} } })).status
  ).toBe(400);
  expect((await post("fork", { ref: { name: "../beta" } })).status).toBe(400);
  const invalid = await app.request("/api/skill/fork", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(invalid.status).toBe(400);
  expect(
    (await app.request("/api/skill?name=alpha&version=bogus")).status
  ).toBe(400);
});

test("スキル中の symlink は読まず、取得元の読み取り専用ファイルは安全に編集できる", async () => {
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  const text = "---\nname: beta\ndescription: Original\n---\n# Original\n";
  place("active/beta/SKILL.md", text);
  place("active/beta/scripts/run.sh", "echo safe\n");
  chmodSync(join(root, "active/beta/scripts/run.sh"), 0o555);
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const script = join(root, ".skill-loom/workspaces/beta/files/scripts/run.sh");
  expect(statSync(script).mode & 0o200).toBe(0o200);
  expect(statSync(script).mode & 0o111).toBe(0o111);
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, ".skill-loom/workspaces/beta/files/escape"));
  const read = await app.request(
    "/api/skill?name=beta&version=work&file=escape"
  );
  expect(read.status).toBe(400);
  expect(readFileSync(outside, "utf8")).toBe("outside");
  expect(fork.content).toBe(text);
});

test("破棄は作業と会話のみを回収し、利用中の内容を残す", async () => {
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  const text = "---\nname: beta\ndescription: Original\n---\n# Original\n";
  place("active/beta/SKILL.md", text);
  const ref = { name: "beta" };
  await post("fork", { ref });
  place(".skill-loom/workspaces/beta/conversation.json", "{}");
  expect((await post("discard", { ref })).status).toBe(200);
  expect(existsSync(join(root, ".skill-loom/workspaces/beta"))).toBe(false);
  expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toBe(text);
  expect(
    JSON.parse(readFileSync(join(root, "skills.lock.json"), "utf8")).external
      .beta
  ).toBeDefined();
});

test("Codex の状態閲覧だけではプロセスを起動せず、保存済み会話を再開する", async () => {
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  place(
    "active/beta/SKILL.md",
    "---\nname: beta\ndescription: Original\n---\n# Original\n"
  );
  const ref = { name: "beta" };
  expect(
    (await post("codex/start", { ref: { name: "alpha" }, prompt: "edit" }))
      .status
  ).toBe(400);
  await post("fork", { ref });
  const messages = [
    { role: "user", text: "Saved instruction" },
    { role: "assistant", text: "Saved response" },
  ];
  place(
    ".skill-loom/workspaces/beta/conversation.json",
    JSON.stringify({ threadId: "saved-thread", messages })
  );
  const response = await app.request("/api/skill/codex?name=beta");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "idle",
    threadId: "saved-thread",
    messages,
    approvals: [],
  });
  expect((await post("codex/start", { ref, prompt: "" })).status).toBe(400);
  await post("discard", { ref });
});

test("再起動時は未完了の適用を戻し、不正な journal を成功扱いにしない", async () => {
  const { recoverSkillApplications } = await import("./domain/skill-apply");
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  const original = "---\nname: beta\ndescription: Original\n---\n# Original\n";
  place("active/beta/SKILL.md", original);
  await post("fork", { ref: { name: "beta" } });
  const lock = readFileSync(join(root, "skills.lock.json"), "utf8");
  const workspace = readFileSync(
    join(root, ".skill-loom/workspaces/beta/workspace.json"),
    "utf8"
  );
  const directory = ".skill-loom/transactions/beta";
  place(`${directory}/active/SKILL.md`, original);
  place("active/beta/SKILL.md", "Interrupted replacement");
  place("vendor/beta/SKILL.md", "Interrupted vendor");
  place(
    `${directory}/journal.json`,
    JSON.stringify({
      version: 1,
      name: "beta",
      phase: "prepared",
      state: "active",
      targets: [
        "active",
        "vendor",
        "upstream",
        "archive",
        "original",
        "baseline",
      ].map((key) => ({
        key,
        existed: key === "active" || key === "original",
      })),
      inventory: lock,
      cli: null,
      tracking: null,
      workspace,
    })
  );
  expect(recoverSkillApplications()).toEqual([]);
  expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toBe(
    original
  );
  expect(existsSync(join(root, "vendor/beta"))).toBe(false);
  expect(readFileSync(join(root, "skills.lock.json"), "utf8")).toBe(lock);
  place(
    `${directory}/journal.json`,
    JSON.stringify({ version: 1, name: "../escape", phase: "prepared" })
  );
  expect(recoverSkillApplications().join(" ")).toContain("復旧が必要");
  expect(existsSync(join(root, directory, "journal.json"))).toBe(true);
});

test("Apply はマーカーのない未解決競合も拒否する", async () => {
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  place(
    "active/beta/SKILL.md",
    "---\nname: beta\ndescription: Original\n---\n# Original\n"
  );
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const path = ".skill-loom/workspaces/beta/workspace.json";
  const metadata = JSON.parse(readFileSync(join(root, path), "utf8"));
  place(path, JSON.stringify({ ...metadata, conflicts: ["new.bin"] }));
  expect((await post("apply", { ref, revision: fork.revision })).status).toBe(
    409
  );
  expect(existsSync(join(root, "vendor/beta"))).toBe(false);
});

test("Markdown の Setext 見出しをマージ競合と誤判定しない", async () => {
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  place(
    "active/beta/SKILL.md",
    "---\nname: beta\ndescription: Original\n---\n# Original\n"
  );
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const content =
    "---\nname: beta\ndescription: Original\n---\nHeading\n=======\n";
  const saved = await (
    await post("save", {
      ref,
      path: "SKILL.md",
      content,
      revision: fork.revision,
    })
  ).json();
  expect(saved.workspace.issues).toEqual([]);
  expect((await post("apply", { ref, revision: saved.revision })).status).toBe(
    200
  );
});

test("適用も復旧も固定名 tmp symlink のリンク先を書き換えない", async () => {
  const { recoverSkillApplications } = await import("./domain/skill-apply");
  inventory({
    beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
  });
  place(
    "active/beta/SKILL.md",
    "---\nname: beta\ndescription: Original\n---\n# Original\n"
  );
  place(
    "cli-lock.json",
    JSON.stringify({ version: 3, skills: { beta: { source: "owner/repo" } } })
  );
  place("outside.txt", "outside");
  const outside = join(root, "outside.txt");
  symlinkSync(outside, join(root, "skills.lock.json.tmp"));
  symlinkSync(outside, join(root, "cli-lock.json.tmp"));
  const ref = { name: "beta" };
  const fork = await (await post("fork", { ref })).json();
  const originalLock = readFileSync(join(root, "skills.lock.json"), "utf8");
  const originalWorkspace = readFileSync(
    join(root, ".skill-loom/workspaces/beta/workspace.json"),
    "utf8"
  );
  expect((await post("apply", { ref, revision: fork.revision })).status).toBe(
    200
  );
  expect(readFileSync(outside, "utf8")).toBe("outside");
  place(
    ".skill-loom/transactions/beta/journal.json",
    JSON.stringify({
      version: 1,
      name: "beta",
      phase: "prepared",
      state: "active",
      targets: [
        "active",
        "vendor",
        "upstream",
        "archive",
        "original",
        "baseline",
      ].map((key) => ({ key, existed: true })),
      inventory: originalLock,
      cli: null,
      tracking: null,
      workspace: originalWorkspace,
    })
  );
  expect(recoverSkillApplications()).toEqual([]);
  expect(readFileSync(outside, "utf8")).toBe("outside");
});

test.each(["duplicate", "inventory", "workspace", "cli", "tracking"])(
  "不正な復旧データ %s は変更前に拒否する",
  async (invalid) => {
    const { recoverSkillApplications } = await import("./domain/skill-apply");
    inventory({
      beta: { source: "owner/repo", skillPath: "skills/beta/SKILL.md" },
    });
    const original =
      "---\nname: beta\ndescription: Original\n---\n# Original\n";
    place("active/beta/SKILL.md", original);
    await post("fork", { ref: { name: "beta" } });
    const lock = readFileSync(join(root, "skills.lock.json"), "utf8");
    const workspace = readFileSync(
      join(root, ".skill-loom/workspaces/beta/workspace.json"),
      "utf8"
    );
    const journal: Record<string, any> = {
      version: 1,
      name: "beta",
      phase: "prepared",
      state: "active",
      targets: [
        "active",
        "vendor",
        "upstream",
        "archive",
        "original",
        "baseline",
      ].map((key) => ({ key, existed: true })),
      inventory: lock,
      cli: null,
      tracking: null,
      workspace,
    };
    if (invalid === "duplicate")
      journal.targets.push({ key: "active", existed: false });
    else journal[invalid] = "not JSON";
    place(".skill-loom/transactions/beta/active/SKILL.md", "Backup");
    place(
      ".skill-loom/transactions/beta/journal.json",
      JSON.stringify(journal)
    );
    expect(recoverSkillApplications().join(" ")).toContain("復旧が必要");
    expect(readFileSync(join(root, "active/beta/SKILL.md"), "utf8")).toBe(
      original
    );
    expect(readFileSync(join(root, "skills.lock.json"), "utf8")).toBe(lock);
    expect(
      existsSync(join(root, ".skill-loom/transactions/beta/journal.json"))
    ).toBe(true);
  }
);

test("編集中の Markdown を閲覧時と同じ描画器で HTML にし、保存や作業用コピーを作らない", async () => {
  const response = await post("preview", { content: "# Draft\n\n**bold**\n" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    html: Bun.markdown.html("# Draft\n\n**bold**\n"),
  });
  expect(existsSync(join(root, ".skill-loom"))).toBe(false);
});

test("プレビュー描画は文字列以外と編集上限を超える内容を拒否する", async () => {
  expect((await post("preview", { content: 1 })).status).toBe(400);
  expect(
    (await post("preview", { content: "a".repeat(1024 * 1024 + 1) })).status
  ).toBe(400);
});

test("1 MiB 境界で多バイト文字が切れる Markdown も省略表示できる", async () => {
  place(
    "skills/alpha/references/large.md",
    `${"a".repeat(1024 * 1024 - 1)}あいう\n`
  );
  const response = await app.request(
    "/api/skill?name=alpha&file=references%2Flarge.md"
  );
  expect(response.status).toBe(200);
  const view = await response.json();
  expect(view.truncated).toBe(true);
  expect(typeof view.html).toBe("string");
});

test("先頭の frontmatter は見出しにせず、YAML のままコードブロックとして描画する", async () => {
  const content = '---\nname: demo\ndescription: "a <b> & c"\n---\n# Title\n';
  const html = (await (await post("preview", { content })).json()).html;
  expect(html).toStartWith(
    "<details open><summary>frontmatter</summary><pre><code>name: demo\ndescription: &quot;a &lt;b&gt; &amp; c&quot;\n</code></pre></details>\n"
  );
  expect(html).toContain("<h1>Title</h1>");
  expect(html).not.toContain("<h2>");
  expect(html).not.toContain("<hr");
  const view = await (await app.request("/api/skill?name=alpha")).json();
  expect(view.html).toStartWith(
    "<details open><summary>frontmatter</summary><pre><code>name: alpha\n"
  );
});

test("frontmatter として閉じていない先頭の区切り線は通常の Markdown として描画する", async () => {
  const content = "---\n# Not frontmatter\n";
  const html = (await (await post("preview", { content })).json()).html;
  expect(html).toBe(Bun.markdown.html(content));
});

test("閉じ行が `---` だけで終わらない場合は frontmatter として扱わない", async () => {
  const content = "---\nname: demo\n----\n# Title\n";
  const html = (await (await post("preview", { content })).json()).html;
  expect(html).toBe(Bun.markdown.html(content));
});
