import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillCodexSession,
  getSkillCodexSession,
  isSkillCodexBusy,
  shutdownAllSkillCodexSessions,
  shutdownSkillCodexSession,
} from "./skill-codex";

let root: string;
let workdir: string;
let metadataPath: string;
const sessions: SkillCodexSession[] = [];

// A real subprocess speaks the CLI 0.164.0 JSON-lines protocol; no model or login.
const server = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.argv[2];
const scenario = JSON.parse(readFileSync(process.argv[3], "utf8"));
appendFileSync(log, JSON.stringify({ args: process.argv.slice(4), pid: process.pid }) + "\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let threadId = "thread-1";
let count = 0;
let turnId;
let policy;
let commandRequest;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  appendFileSync(log, JSON.stringify(m) + "\n");
  const reply = result => send({ id: m.id, result });
  if (scenario.noReply && scenario.noReply === m.method) continue;
  if (scenario.exitAt && scenario.exitAt === m.method) process.exit(7);
  if (scenario.rpcError && scenario.rpcError === m.method) { send({id:m.id,error:{code:-32000,message:"fake RPC failure"}}); continue; }
  if (m.method === "initialize") {
    if (scenario.initializeDelay) await Bun.sleep(scenario.initializeDelay);
    reply({ userAgent: scenario.userAgent ?? "skill_loom/0.164.0 (JSON-RPC fixture)" });
  }
  if (m.method === "account/read") reply({ account: { type: scenario.accountType ?? "chatgpt" }, requiresOpenaiAuth: true });
  if (m.method === "config/read") {
    const config = {};
    const args = process.argv.slice(4);
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "-c") continue;
      const [key, ...rest] = args[++i].split("=");
      let object = config;
      const parts = key.split(".");
      while (parts.length > 1) object = object[parts.shift()] ??= {};
      const value = rest.join("=");
      object[parts[0]] = value === "{}" ? {} : JSON.parse(value);
    }
    if (scenario.inheritedMcp) {
      config.mcp_servers = { inherited: { command: "never-run-this", ...config.mcp_servers?.inherited } };
    }
    reply({ config: { ...config, ...scenario.config } });
  }
  if (m.method === "thread/start" || m.method === "thread/resume") {
    threadId = m.params.threadId ?? threadId;
    policy = { type: "workspaceWrite", writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true, ...scenario.sandbox };
    reply({ thread: { id: threadId, turns: [] }, cwd: m.params.cwd,
      runtimeWorkspaceRoots: scenario.readOnlyBootstrap ? [] : [m.params.cwd],
      sandbox: scenario.readOnlyBootstrap ? { type: "readOnly", networkAccess: false } : policy,
      approvalPolicy: m.params.approvalPolicy, approvalsReviewer: "user" });
  }
  if (m.method === "turn/start") {
    turnId = "turn-" + ++count;
    reply({ turn: { id: turnId, status: "inProgress", items: [] } });
    const params = { threadId, turnId, itemId: "message-1" };
    for (const request of scenario.requests ?? []) send({ ...request, params: { ...params, ...request.params } });
    if (scenario.fatalError) {
      send({ method: "error", params: { ...params, error: { message: "fake fatal error" }, willRetry: false } });
      continue;
    }
    if (scenario.malformed) { process.stdout.write("not json\n"); continue; }
    if (scenario.approvals) {
      send({ method: "item/started", params: { threadId, turnId,
        item: { type: "fileChange", id: "patch-1", changes: [
          { path: scenario.patchPath ?? process.cwd() + "/SKILL.md", diff: "+improved", kind: { type: "update" } }
        ] } } });
      send({ id: 17, method: "item/commandExecution/requestApproval", params: {
        ...params, cwd: process.cwd(), command: "bun test", ...scenario.commandApproval } });
      send({ id: "17", method: "item/fileChange/requestApproval", params: {
        ...params, itemId: "patch-1", reason: "Update skill", ...scenario.fileApproval } });
      continue;
    }
    if (scenario.hold) continue;
    send({ method: "item/agentMessage/delta", params: { ...params, delta: "Hello " } });
    send({ method: "item/agentMessage/delta", params: { ...params, delta: "world" } });
    send({ method: "item/completed", params: { threadId, turnId,
      item: { type: "agentMessage", id: "message-1", text: "Hello world" } } });
    send({ method: "turn/completed", params: { threadId,
      turn: { id: turnId, status: "completed", items: [], error: null } } });
    if (scenario.staleApproval) send({id:"stale",method:"item/commandExecution/requestApproval",
      params:{...params,cwd:process.cwd(),command:"must not run"}});
  }
  if (m.method === "turn/interrupt") {
    reply({});
    send({ method: "turn/completed", params: { threadId,
      turn: { id: turnId, status: "interrupted", items: [], error: null } } });
  }
  if (m.method === "command/exec") {
    if (scenario.holdCommand) { commandRequest = m.id; continue; }
    reply({ exitCode: 0, stdout: "script output", stderr: "" });
  }
  if (m.method === "command/exec/terminate") {
    reply({});
    if (commandRequest !== undefined) {
      const id = commandRequest;
      const finish = () => {
        appendFileSync(log,JSON.stringify({event:"commandExited"}) + "\n");
        send({id,result:{exitCode:130,stdout:"",stderr:"interrupted"}});
      };
      if (scenario.terminateDelay) setTimeout(finish,scenario.terminateDelay); else finish();
    }
    commandRequest = undefined;
  }
  if (m.id === "tool-command" && m.result && scenario.completeTool) {
    send({ method: "item/agentMessage/delta", params: {threadId,turnId,itemId:"tool-result",delta:"Command handled"} });
    send({ method: "turn/completed", params: {threadId,turn:{id:turnId,status:"completed",items:[],error:null}} });
  }
  if (m.id === "finish") {
    send({ method: "turn/completed", params: { threadId,
      turn: { id: turnId, status: "completed", items: [], error: null } } });
  }
}
`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "skill-codex-test-")));
  workdir = join(root, "work");
  metadataPath = join(root, "metadata", "codex.json");
  mkdirSync(workdir);
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.shutdown()));
  await shutdownAllSkillCodexSessions();
  const result = Bun.spawnSync(["/usr/bin/trash", root]);
  expect(result.exitCode).toBe(0);
});

function session(scenario: Record<string, unknown> = {}) {
  const script = join(root, "fake-server.ts");
  writeFileSync(script, server);
  const scenarioPath = join(root, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const instance = new SkillCodexSession(workdir, metadataPath, {
    command: [process.execPath, script, join(root, "rpc.jsonl"), scenarioPath],
    requestTimeoutMs: scenario.noReply ? 150 : 2000,
  });
  sessions.push(instance);
  return instance;
}

function transcript(): any[] {
  return readFileSync(join(root, "rpc.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function settled(instance: SkillCodexSession) {
  for (let i = 0; i < 200 && instance.state().status !== "idle"; i++) {
    await Bun.sleep(5);
  }
  expect(instance.state().status).toBe("idle");
}

test("lazy initialization, existing-login handshake, a streamed turn and minimal persistence", async () => {
  const instance = session();
  expect(instance.state()).toEqual({
    status: "idle",
    messages: [],
    approvals: [],
  });
  expect(existsSync(join(root, "rpc.jsonl"))).toBe(false);
  await instance.start("Improve this skill");
  await settled(instance);
  expect(instance.state().messages).toEqual([
    { role: "user", text: "Improve this skill" },
    { role: "assistant", text: "Hello world" },
  ]);
  const calls = transcript();
  expect(
    calls.filter((entry) => entry.method).map((entry) => entry.method)
  ).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "config/read",
    "thread/start",
    "turn/start",
  ]);
  const turn = calls.find((entry) => entry.method === "turn/start");
  expect(turn.params.sandboxPolicy).toEqual({
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  expect(turn.params.cwd).toBe(workdir);
  expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toEqual({
    threadId: "thread-1",
    messages: instance.state().messages,
  });
});

test("server restart resumes the persisted thread with the same restricted policy", async () => {
  const first = session();
  await first.start("First");
  await settled(first);
  await first.shutdown();
  const second = session();
  expect(second.state().threadId).toBe("thread-1");
  expect(second.state().messages).toHaveLength(2);
  await second.start("Second");
  await settled(second);
  const calls = transcript();
  expect(calls.filter((m) => m.method === "thread/start")).toHaveLength(1);
  expect(calls.find((m) => m.method === "thread/resume").params).toMatchObject({
    threadId: "thread-1",
    cwd: workdir,
    sandbox: "workspace-write",
    approvalsReviewer: "user",
  });
  expect(second.state().messages).toHaveLength(4);
});

test("factory shares one session per workcopy, reports busy and releases a shut down session", async () => {
  const first = getSkillCodexSession(workdir, metadataPath);
  expect(getSkillCodexSession(workdir, metadataPath)).toBe(first);
  expect(isSkillCodexBusy(workdir)).toBe(false);
  expect(() =>
    getSkillCodexSession(workdir, join(root, "different.json"))
  ).toThrow("metadata");
  await first.shutdown();
  expect(getSkillCodexSession(workdir, metadataPath)).not.toBe(first);
});

test("factory compares canonical workdir and metadata paths", async () => {
  const first = getSkillCodexSession(workdir, metadataPath);
  symlinkSync(root, join(root, "alias-root"));
  expect(
    getSkillCodexSession(
      join(root, "alias-root", "work"),
      join(root, "alias-root", "metadata", "codex.json")
    )
  ).toBe(first);
});

test.each(["accept", "decline"] as const)(
  "scripts only execute after dynamic-tool %s, regardless of inherited allow rules",
  async (decision) => {
    const instance = session({
      hold: true,
      completeTool: true,
      config: { rules: { allow: ["bash"] } },
      requests: [
        {
          id: "tool-command",
          method: "item/tool/call",
          params: {
            callId: "call-1",
            namespace: null,
            tool: "skill_exec",
            arguments: { argv: ["bash", "scripts/foo.sh"] },
          },
        },
      ],
    });
    await instance.start("Run the script");
    await until(() => instance.state().status === "approval");
    expect(instance.state().approvals[0]!.detail).toContain("scripts/foo.sh");
    expect(transcript().some((m) => m.method === "command/exec")).toBe(false);
    const thread = transcript().find((m) => m.method === "thread/start");
    expect(thread.params.config["features.shell_tool"]).toBe(false);
    expect(thread.params.config["features.unified_exec"]).toBe(false);
    expect(thread.params.dynamicTools[0]).toMatchObject({
      type: "function",
      name: "skill_exec",
    });
    await instance.approve("tool-command", decision);
    await settled(instance);
    const exec = transcript().find((m) => m.method === "command/exec");
    if (decision === "accept") {
      expect(exec.params.command).toEqual(["bash", "scripts/foo.sh"]);
      expect(exec.params.cwd).toBe(workdir);
      expect(exec.params.sandboxPolicy).toEqual({
        type: "workspaceWrite",
        writableRoots: [workdir],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      });
      expect(
        transcript().find((m) => m.id === "tool-command" && m.result).result
          .success
      ).toBe(true);
    } else {
      expect(exec).toBeUndefined();
      expect(
        transcript().find((m) => m.id === "tool-command" && m.result).result
          .success
      ).toBe(false);
    }
  }
);

test("interrupt terminates the approved dynamic command before interrupting the turn", async () => {
  const instance = session({
    hold: true,
    holdCommand: true,
    terminateDelay: 30,
    requests: [
      {
        id: "tool-command",
        method: "item/tool/call",
        params: {
          callId: "call-1",
          namespace: null,
          tool: "skill_exec",
          arguments: { argv: ["bash", "scripts/long.sh"] },
        },
      },
    ],
  });
  await instance.start("Long script");
  await until(() => instance.state().status === "approval");
  await instance.approve("tool-command", "accept");
  await until(() => transcript().some((m) => m.method === "command/exec"));
  await instance.interrupt();
  await settled(instance);
  const methods = transcript().map((m) => m.method);
  expect(methods.indexOf("command/exec/terminate")).toBeLessThan(
    methods.indexOf("turn/interrupt")
  );
  expect(
    transcript().findIndex((m) => m.event === "commandExited")
  ).toBeLessThan(methods.indexOf("turn/interrupt"));
  expect(transcript().some((m) => m.id === "tool-command" && m.result)).toBe(
    false
  );
});

test("each command requires approval and network access is explicit for that command", async () => {
  const instance = session({
    hold: true,
    completeTool: true,
    requests: [
      {
        id: "tool-command",
        method: "item/tool/call",
        params: {
          callId: "call-1",
          namespace: null,
          tool: "skill_exec",
          arguments: { argv: ["bash", "scripts/network.sh"], network: true },
        },
      },
    ],
  });
  await instance.start("First");
  await until(() => instance.state().status === "approval");
  expect(instance.state().approvals[0]!.detail).toContain("許可を要求");
  await instance.approve("tool-command", "accept");
  await settled(instance);
  expect(
    transcript().find((m) => m.method === "command/exec").params.sandboxPolicy
      .networkAccess
  ).toBe(true);
  await instance.start("Again");
  await until(() => instance.state().status === "approval");
  expect(transcript().filter((m) => m.method === "command/exec")).toHaveLength(
    1
  );
  await instance.approve("tool-command", "decline");
  await settled(instance);
  expect(transcript().filter((m) => m.method === "command/exec")).toHaveLength(
    1
  );
});

test("shutdown terminates the approved command without replying to trigger more model work", async () => {
  const instance = session({
    hold: true,
    holdCommand: true,
    requests: [
      {
        id: "tool-command",
        method: "item/tool/call",
        params: {
          callId: "call-1",
          namespace: null,
          tool: "skill_exec",
          arguments: { argv: ["bash", "scripts/long.sh"] },
        },
      },
    ],
  });
  await instance.start("Long script");
  await until(() => instance.state().status === "approval");
  await instance.approve("tool-command", "accept");
  await until(() => transcript().some((m) => m.method === "command/exec"));
  await instance.shutdown();
  expect(transcript().some((m) => m.method === "command/exec/terminate")).toBe(
    true
  );
  expect(transcript().some((m) => m.id === "tool-command" && m.result)).toBe(
    false
  );
});

test.each([
  { argv: [] },
  { argv: ["bash"], stdin: "unexpected" },
  { argv: ["bash"], network: "yes" },
  { argv: ["bash", "x".repeat(100_001)] },
  { argv: ["bash\0"] },
])(
  "malformed or excessive dynamic-tool arguments cannot execute",
  async (args) => {
    const instance = session({
      hold: true,
      requests: [
        {
          id: "tool-command",
          method: "item/tool/call",
          params: {
            callId: "call-1",
            namespace: null,
            tool: "skill_exec",
            arguments: args,
          },
        },
      ],
    });
    await instance.start("Validate");
    await until(() =>
      transcript().some((m) => m.id === "tool-command" && m.result)
    );
    expect(transcript().some((m) => m.method === "command/exec")).toBe(false);
    expect(instance.state().approvals).toEqual([]);
    expect(
      instance
        .state()
        .messages.some((m) => m.role === "system" && m.text.includes("拒否"))
    ).toBe(true);
  }
);

test("excessive prompts are rejected before spawning a process", async () => {
  const instance = session();
  await expect(instance.start("x".repeat(100_001))).rejects.toThrow("100KB");
  expect(existsSync(join(root, "rpc.jsonl"))).toBe(false);
  expect(instance.state().status).toBe("idle");
});

test.each([
  "skill_loom/0.165.0 (future)",
  "skill_loom/0.163.0 (old)",
  "unknown",
])(
  "unverified CLI userAgent is refused before login or thread creation: %s",
  async (userAgent) => {
    const instance = session({ userAgent });
    await expect(instance.start("Never infer")).rejects.toThrow("0.164");
    expect(instance.state().status).toBe("failed");
    expect(
      transcript().some((m) =>
        [
          "account/read",
          "thread/start",
          "thread/resume",
          "turn/start",
        ].includes(m.method)
      )
    ).toBe(false);
  }
);

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("command and file approvals preserve typed IDs and display the actual patch", async () => {
  const instance = session({ approvals: true });
  await instance.start("Edit");
  await until(() => instance.state().approvals.length === 2);
  expect(instance.state().status).toBe("approval");
  expect(instance.state().approvals[1]!.detail).toContain("SKILL.md");
  expect(instance.state().approvals[1]!.detail).toContain("+improved");
  await expect(
    instance.approve(17, "acceptForSession" as "accept")
  ).rejects.toThrow("decision");
  await instance.approve(17, "accept");
  expect(instance.state().approvals.map((a) => a.id)).toEqual(["17"]);
  await instance.approve("17", "decline");
  expect(instance.state().status).toBe("running");
  await expect(instance.approve(17, "accept")).rejects.toThrow("expired");
  await until(() => transcript().some((m) => m.id === "17" && m.result));
  expect(transcript().filter((m) => m.result)).toEqual([
    { id: 17, result: { decision: "accept" } },
    { id: "17", result: { decision: "decline" } },
  ]);
  await instance.interrupt();
  await settled(instance);
  expect(instance.state().approvals).toEqual([]);
});

test("disables every inherited MCP in a preflight restart before creating a thread", async () => {
  const instance = session({ inheritedMcp: true });
  await instance.start("Edit without inherited MCP tools");
  await settled(instance);
  const calls = transcript();
  expect(calls.filter((m) => m.method === "initialize")).toHaveLength(2);
  const threadIndex = calls.findIndex((m) => m.method === "thread/start");
  expect(
    calls.slice(0, threadIndex).filter((m) => m.method === "config/read")
  ).toHaveLength(2);
  expect(
    calls.find((m) => m.method === "thread/start").params.config[
      "mcp_servers.inherited.enabled"
    ]
  ).toBe(false);
  expect(calls.filter((m) => m.args)[1].args).toContain(
    "mcp_servers.inherited.enabled=false"
  );
});

test("a read-only bootstrap still sends an explicit restricted sandbox on every turn", async () => {
  const instance = session({ readOnlyBootstrap: true });
  await instance.start("First");
  await settled(instance);
  await instance.start("Second");
  await settled(instance);
  const turns = transcript().filter((m) => m.method === "turn/start");
  expect(turns).toHaveLength(2);
  for (const turn of turns) {
    expect(turn.params.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    expect(turn.params.permissions).toBeUndefined();
    expect(turn.params.approvalPolicy.granular.sandbox_approval).toBe(false);
  }
});

test("startup and running turns reject concurrent starts; interrupt keeps the session reusable", async () => {
  const instance = session({ hold: true, initializeDelay: 30 });
  const starting = instance.start("First");
  expect(instance.state().status).toBe("starting");
  await expect(instance.start("Concurrent")).rejects.toThrow("busy");
  await starting;
  expect(instance.state().status).toBe("running");
  await expect(instance.start("Concurrent")).rejects.toThrow("busy");
  await instance.interrupt();
  await settled(instance);
  await instance.start("Next");
  expect(
    instance.state().messages.filter((m) => m.role === "user")
  ).toHaveLength(2);
  await instance.interrupt();
  await settled(instance);
  expect(transcript().filter((m) => m.method === "initialize")).toHaveLength(1);
});

test("late approval requests cannot resurrect a finished turn", async () => {
  const instance = session({ staleApproval: true });
  await instance.start("Finish");
  await until(() => instance.state().status !== "running");
  expect(instance.state().status).toBe("idle");
  expect(instance.state().approvals).toEqual([]);
});

test("unsupported requests fail closed and remain visible", async () => {
  const instance = session({
    hold: true,
    requests: [
      { id: "unknown", method: "future/request" },
      { id: "auth", method: "account/chatgptAuthTokens/refresh" },
    ],
  });
  await instance.start("Stay sandboxed");
  await until(() => transcript().filter((m) => m.error).length === 2);
  expect(instance.state().approvals).toEqual([]);
  for (const response of transcript().filter((m) => m.error))
    expect(response.error.code).toBe(-32601);
});

test.each(["accept", "decline"] as const)(
  "typed read/network requests require explicit %s and never add writes",
  async (decision) => {
    const requested = {
      network: { enabled: true },
      fileSystem: { read: [join(root, "reference.txt")], write: null },
    };
    const instance = session({
      hold: true,
      requests: [
        {
          id: "access",
          method: "item/permissions/requestApproval",
          params: {
            cwd: workdir,
            reason: "Reference data and network",
            permissions: requested,
          },
        },
      ],
    });
    await instance.start("Request data");
    await until(() => instance.state().approvals.length === 1);
    expect(instance.state().status).toBe("approval");
    expect(instance.state().approvals[0]!.detail).toContain("reference.txt");
    expect(transcript().some((m) => m.id === "access" && m.result)).toBe(false);
    await instance.approve("access", decision);
    await until(() => transcript().some((m) => m.id === "access" && m.result));
    expect(
      transcript().find((m) => m.id === "access" && m.result).result
    ).toEqual({
      permissions: decision === "accept" ? requested : {},
      scope: "turn",
    });
    expect(instance.state().status).toBe("running");
    await instance.interrupt();
    await settled(instance);
  }
);

test("typed access requests cannot grant outside writes or unhandled glob permissions", async () => {
  const instance = session({
    hold: true,
    requests: [
      {
        id: "write",
        method: "item/permissions/requestApproval",
        params: {
          cwd: workdir,
          permissions: {
            network: null,
            fileSystem: { read: null, write: ["/"] },
          },
        },
      },
      {
        id: "glob",
        method: "item/permissions/requestApproval",
        params: {
          cwd: workdir,
          permissions: {
            network: null,
            fileSystem: {
              read: null,
              write: null,
              entries: [
                {
                  path: { type: "glob_pattern", pattern: "/**" },
                  access: "read",
                },
              ],
            },
          },
        },
      },
    ],
  });
  await instance.start("Stay confined");
  await until(
    () => transcript().filter((m) => m.result?.scope === "turn").length === 2
  );
  expect(instance.state().approvals).toEqual([]);
  expect(
    instance.state().messages.filter((m) => m.role === "system")
  ).toHaveLength(2);
  for (const reply of transcript().filter((m) => m.result?.scope === "turn"))
    expect(reply.result.permissions).toEqual({});
});

test.each([
  { config: { features: { hooks: true } } },
  {
    config: {
      sandbox_workspace_write: {
        writable_roots: ["/"],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    },
  },
  { config: { mcp_servers: { enforced: { enabled: true } } } },
  { sandbox: { writableRoots: ["/"] } },
  { sandbox: { excludeSlashTmp: false } },
  { accountType: "apiKey" },
])(
  "unsafe configuration or login cannot reach turn/start: %j",
  async (scenario) => {
    const instance = session(scenario);
    await expect(instance.start("Do not infer")).rejects.toThrow();
    expect(instance.state().status).toBe("failed");
    expect(transcript().some((m) => m.method === "turn/start")).toBe(false);
  }
);

test.each([
  { noReply: "initialize" },
  { exitAt: "turn/start" },
  { rpcError: "thread/start" },
  { malformed: true },
  { fatalError: true },
])(
  "transport failures settle requests and expose failed state: %j",
  async (scenario) => {
    const instance = session(scenario);
    await instance.start("First").catch(() => {});
    await until(() => instance.state().status === "failed");
    expect(instance.state().error).toBeTruthy();
    expect(instance.state().approvals).toEqual([]);
  }
);

test("a failed process can restart and resume, without dropping conversation history", async () => {
  const instance = session({ exitAt: "turn/start" });
  await expect(instance.start("First")).rejects.toThrow();
  writeFileSync(join(root, "scenario.json"), "{}");
  await instance.start("Retry");
  await settled(instance);
  expect(
    instance.state().messages.filter((m) => m.role === "user")
  ).toHaveLength(2);
  expect(transcript().some((m) => m.method === "thread/resume")).toBe(true);
});

test("shutdown during initialization rejects the pending start and kills only the owned server", async () => {
  const instance = session({ initializeDelay: 2000 });
  const starting = instance.start("Never infer");
  const rejected = starting.catch((error: Error) => error);
  await until(() => existsSync(join(root, "rpc.jsonl")));
  const pid = transcript()[0].pid;
  await instance.shutdown();
  expect(((await rejected) as Error).message).toContain("shut down");
  expect(() => process.kill(pid, 0)).toThrow();
  expect(instance.state().approvals).toEqual([]);
  await expect(instance.start("Closed")).rejects.toThrow("shut down");
});

test("metadata is outside files, malformed metadata is preserved, and state is a snapshot", async () => {
  expect(
    () => new SkillCodexSession(workdir, join(workdir, "conversation.json"))
  ).toThrow("outside");
  symlinkSync(workdir, join(root, "alias"));
  expect(
    () =>
      new SkillCodexSession(workdir, join(root, "alias", "conversation.json"))
  ).toThrow("outside");
  mkdirSync(join(root, "metadata"));
  writeFileSync(metadataPath, "not json");
  expect(() => session()).toThrow();
  expect(readFileSync(metadataPath, "utf8")).toBe("not json");
  writeFileSync(
    metadataPath,
    JSON.stringify({ messages: [{ role: "user", text: "saved" }] })
  );
  const instance = session();
  instance.state().messages[0]!.text = "mutated";
  expect(instance.state().messages[0]!.text).toBe("saved");
});

test("discard shutdown never creates a session or reads corrupt saved metadata", async () => {
  mkdirSync(join(root, "metadata"));
  writeFileSync(metadataPath, "malformed conversation");
  await shutdownSkillCodexSession(workdir);
  expect(readFileSync(metadataPath, "utf8")).toBe("malformed conversation");
  expect(existsSync(join(root, "rpc.jsonl"))).toBe(false);
});

test("a metadata parent symlink cannot create directories inside the workcopy", () => {
  symlinkSync(workdir, join(root, "alias"));
  expect(
    () =>
      new SkillCodexSession(
        workdir,
        join(root, "alias", "created", "conversation.json")
      )
  ).toThrow("outside");
  expect(existsSync(join(workdir, "created"))).toBe(false);
});

test.each([
  {
    commandApproval: {
      additionalPermissions: { fileSystem: { write: ["/"] } },
    },
    fileApproval: { grantRoot: "/" },
  },
  { commandApproval: { cwd: "/" }, patchPath: "/outside/SKILL.md" },
  {
    commandApproval: { networkApprovalContext: { host: "example.invalid" } },
    fileApproval: { grantRoot: "/tmp" },
  },
])(
  "outside-root requests are rejected with visible policy reasons: %j",
  async (scenario) => {
    const instance = session({ approvals: true, ...scenario });
    await instance.start("Stay inside");
    await until(
      () =>
        transcript().filter((m) => m.result?.decision === "decline").length ===
        2
    );
    expect(instance.state().approvals).toEqual([]);
    const refusals = instance
      .state()
      .messages.filter((m) => m.role === "system");
    expect(refusals).toHaveLength(2);
    expect(refusals[0]!.text).toContain("bun test");
    expect(refusals[0]!.text).toContain("承認できません");
    await expect(instance.approve(17, "accept")).rejects.toThrow("expired");
  }
);

test("login and retry errors explain the next action", async () => {
  const instance = session({ accountType: "none" });
  await expect(instance.start("No inference")).rejects.toThrow("codex login");
  expect(instance.state().error).toContain("ChatGPT");
  expect(instance.state().error).toContain("再起動");
});

test("interrupt during initialization cancels promptly and can be retried", async () => {
  const instance = session({ initializeDelay: 2000 });
  const result = instance.start("Wait").catch((error: Error) => error);
  await until(() => existsSync(join(root, "rpc.jsonl")));
  const state = await instance.interrupt();
  expect(state.status).toBe("failed");
  expect(((await result) as Error).message).toContain("中断");
  writeFileSync(join(root, "scenario.json"), "{}");
  await instance.start("Retry");
  await settled(instance);
});

test.each([
  { method: "item/agentMessage/delta", params: { itemId: "bad", delta: 7 } },
  {
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "bad", text: null } },
  },
  {
    method: "item/started",
    params: {
      item: {
        type: "fileChange",
        id: "bad",
        changes: [{ path: "SKILL.md", diff: null }],
      },
    },
  },
])(
  "malformed supported notifications fail the turn without creating approvals: %j",
  async (notification) => {
    const instance = session({ hold: true, requests: [notification] });
    await instance.start("Validate incoming events").catch(() => {});
    await until(() => instance.state().status === "failed");
    expect(instance.state().error).toContain("Invalid Codex");
    expect(instance.state().approvals).toEqual([]);
    expect(transcript().some((m) => m.method === "command/exec")).toBe(false);
  }
);

test("typed read entries preserve exact paths without granting writes or disabled network", async () => {
  const entries = [
    {
      access: "read",
      path: { type: "path", path: join(root, "reference.txt") },
    },
  ];
  const instance = session({
    hold: true,
    requests: [
      {
        id: "read-entry",
        method: "item/permissions/requestApproval",
        params: {
          cwd: workdir,
          permissions: {
            network: { enabled: false },
            fileSystem: { read: null, write: [], entries },
          },
        },
      },
    ],
  });
  await instance.start("Read reference data");
  await until(() => instance.state().approvals.length === 1);
  await instance.approve("read-entry", "accept");
  await until(() =>
    transcript().some((m) => m.id === "read-entry" && m.result)
  );
  expect(
    transcript().find((m) => m.id === "read-entry" && m.result).result
  ).toEqual({
    permissions: { fileSystem: { read: null, write: null, entries } },
    scope: "turn",
  });
  await instance.interrupt();
  await settled(instance);
});

test.each([
  { network: { enabled: true, unexpected: true } },
  { network: { enabled: "true" } },
  { fileSystem: { read: ["relative.txt"] } },
  {
    fileSystem: {
      entries: [{ access: "write", path: { type: "path", path: "/" } }],
    },
  },
  { fileSystem: { read: ["/tmp/reference"], unexpected: true } },
])(
  "unsupported permission profiles are refused before UI approval: %j",
  async (permissions) => {
    const instance = session({
      hold: true,
      requests: [
        {
          id: "invalid-access",
          method: "item/permissions/requestApproval",
          params: { cwd: workdir, permissions },
        },
      ],
    });
    await instance.start("Keep permission validation");
    await until(() =>
      transcript().some((m) => m.id === "invalid-access" && m.result)
    );
    expect(
      transcript().find((m) => m.id === "invalid-access" && m.result).result
    ).toEqual({ permissions: {}, scope: "turn" });
    expect(instance.state().approvals).toEqual([]);
    await instance.interrupt();
    await settled(instance);
  }
);
