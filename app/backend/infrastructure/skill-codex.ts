import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import type { SkillCodexState } from "../../shared/skill-workspace-types";

type Id = string | number;
type JsonObject = Record<string, any>;
type Execution = { argv: string[]; network: boolean };
type ToolArguments = { argv: string[]; network?: boolean };
type SavedSession = Pick<SkillCodexState, "threadId" | "messages">;
type ReadEntry = { access: "read"; path: { type: "path"; path: string } };
type FilePermissions = {
  read?: string[] | null;
  write?: [] | null;
  entries?: ReadEntry[] | null;
};
type AccessGrant = {
  network?: { enabled: true };
  fileSystem?: { read: string[] | null; write: null; entries?: ReadEntry[] };
};
type RequestedPermissions = {
  network?: { enabled: boolean | null } | null;
  fileSystem?: FilePermissions | null;
};
const approvalMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
] as const;
type ApprovalMethod = (typeof approvalMethods)[number];
type TurnParams = JsonObject & { threadId: string; turnId: string };
type ApprovalRequest = { id: Id; method: ApprovalMethod; params: TurnParams };
const turnEventMethods = [
  "item/started",
  "item/agentMessage/delta",
  "item/completed",
  "turn/completed",
] as const;
type TurnEventMethod = (typeof turnEventMethods)[number];
type TurnEvent = { method: TurnEventMethod; params: JsonObject };
type Notification = { method: string; params: JsonObject };
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const approvalPolicy = {
  granular: {
    sandbox_approval: false,
    rules: true,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  },
};
const sandboxPolicy = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
};
const disabledFeatures = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "artifact",
  "view_image",
  "hooks",
  "plugins",
  "remote_plugin",
  "apps",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "code_mode",
  "multi_agent",
  "multi_agent_v2",
  "shell_snapshot",
  "skill_mcp_dependency_install",
  "workspace_dependencies",
  "goals",
  "memories",
];
const executeTool = {
  type: "function",
  name: "skill_exec",
  description:
    "Execute a command in the skill workcopy. Every invocation requires explicit user approval. Request network access explicitly when needed. Native shell tools are disabled; use this tool for scripts and commands.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["argv"],
    properties: {
      argv: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: { type: "string", maxLength: 100_000 },
      },
      network: { type: "boolean" },
    },
  },
};

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function turnEventMethod(method: string): method is TurnEventMethod {
  return turnEventMethods.includes(method as TurnEventMethod);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeApprovalPolicy(value: unknown): boolean {
  return (
    object(value) &&
    object(value.granular) &&
    Object.keys(value).length === 1 &&
    Object.keys(value.granular).length ===
      Object.keys(approvalPolicy.granular).length &&
    Object.entries(approvalPolicy.granular).every(
      ([key, expected]) => value.granular[key] === expected
    )
  );
}

function isolationConfig(): Record<string, unknown> {
  return {
    sandbox_mode: "workspace-write",
    "sandbox_workspace_write.writable_roots": [],
    "sandbox_workspace_write.network_access": false,
    "sandbox_workspace_write.exclude_tmpdir_env_var": true,
    "sandbox_workspace_write.exclude_slash_tmp": true,
    approvals_reviewer: "user",
    model_provider: "openai",
    mcp_servers: {},
    notify: [],
    web_search: "disabled",
    allow_login_shell: false,
    "shell_environment_policy.inherit": "none",
    "shell_environment_policy.experimental_use_profile": false,
    "shell_environment_policy.set": {},
    "features.request_permissions_tool": true,
    ...Object.fromEntries(
      disabledFeatures.map((name) => [`features.${name}`, false])
    ),
    ...Object.fromEntries(
      Object.entries(approvalPolicy.granular).map(([key, value]) => [
        `approval_policy.granular.${key}`,
        value,
      ])
    ),
  };
}

function metadataFile(workdir: string, metadataPath: string): string {
  const target = resolve(metadataPath);
  if (inside(workdir, target))
    throw new Error("Codex metadata must be outside the workcopy");
  let existingParent = dirname(target);
  while (!existsSync(existingParent)) existingParent = dirname(existingParent);
  if (inside(workdir, realpathSync(existingParent)))
    throw new Error("Codex metadata must be outside the workcopy");
  mkdirSync(dirname(target), { recursive: true });
  const canonical = resolve(realpathSync(dirname(target)), basename(target));
  if (
    inside(workdir, canonical) ||
    (existsSync(target) && lstatSync(target).isSymbolicLink())
  )
    throw new Error(
      "Codex metadata must be outside the workcopy and not a symlink"
    );
  return canonical;
}

function savedMessage(
  value: unknown
): value is SavedSession["messages"][number] {
  return (
    object(value) &&
    ["user", "assistant", "system"].includes(value.role) &&
    typeof value.text === "string"
  );
}

function readSession(path: string): SavedSession | undefined {
  if (!existsSync(path)) return undefined;
  const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(saved) ||
    (saved.threadId !== undefined && typeof saved.threadId !== "string") ||
    !Array.isArray(saved.messages) ||
    !saved.messages.every(savedMessage)
  )
    throw new Error("Invalid Codex session metadata");
  return {
    threadId: saved.threadId,
    messages: saved.messages.map(({ role, text }) => ({ role, text })),
  };
}

function safeFeatures(value: unknown): boolean {
  return (
    object(value) &&
    disabledFeatures.every((key) => value[key] === false) &&
    value.request_permissions_tool === true
  );
}

function safeShellEnvironment(value: unknown): boolean {
  return (
    object(value) &&
    value.inherit === "none" &&
    value.experimental_use_profile === false &&
    object(value.set) &&
    Object.keys(value.set).length === 0
  );
}

function safeRuntimeConfig(config: JsonObject): boolean {
  return (
    Array.isArray(config.notify) &&
    config.notify.length === 0 &&
    config.model_provider === "openai" &&
    safeApprovalPolicy(config.approval_policy) &&
    config.approvals_reviewer === "user" &&
    config.allow_login_shell === false &&
    config.web_search === "disabled" &&
    safeShellEnvironment(config.shell_environment_policy)
  );
}

function safeMcpConfig(
  value: unknown,
  allowInherited: boolean
): value is Record<string, JsonObject> {
  return (
    object(value) &&
    Object.values(value).every(
      (server) => object(server) && (allowInherited || server.enabled === false)
    )
  );
}

function validArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    !!value[0] &&
    Buffer.byteLength(JSON.stringify(value)) <= 100_000
  );
}

function toolArguments(value: unknown): value is ToolArguments {
  return (
    object(value) &&
    !Object.keys(value).some((key) => !["argv", "network"].includes(key)) &&
    validArgv(value.argv) &&
    (value.network === undefined || typeof value.network === "boolean")
  );
}

function readablePath(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && !/[*?\[\]]/.test(path);
}

function readableEntry(entry: unknown): entry is ReadEntry {
  return (
    object(entry) &&
    entry.access === "read" &&
    object(entry.path) &&
    entry.path.type === "path" &&
    readablePath(entry.path.path)
  );
}

function safeReadPaths(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every(readablePath));
}

function safeReadEntries(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every(readableEntry));
}

function safeFilePermissions(
  value: unknown
): value is FilePermissions | null | undefined {
  if (value == null) return true;
  return (
    object(value) &&
    !Object.keys(value).some(
      (key) => !["read", "write", "entries", "globScanMaxDepth"].includes(key)
    ) &&
    (value.write == null ||
      (Array.isArray(value.write) && value.write.length === 0)) &&
    safeReadPaths(value.read) &&
    safeReadEntries(value.entries)
  );
}

function safeNetworkPermissions(value: unknown): boolean {
  if (value == null) return true;
  return (
    object(value) &&
    !Object.keys(value).some((key) => key !== "enabled") &&
    (value.enabled === null || typeof value.enabled === "boolean")
  );
}

function requestedPermissions(value: unknown): value is RequestedPermissions {
  return (
    object(value) &&
    !Object.keys(value).some(
      (key) => !["network", "fileSystem"].includes(key)
    ) &&
    safeNetworkPermissions(value.network) &&
    safeFilePermissions(value.fileSystem)
  );
}

function fileReadGrant(fs: FilePermissions): AccessGrant["fileSystem"] {
  if (!fs.read?.length && !fs.entries?.length) return undefined;
  const grant: NonNullable<AccessGrant["fileSystem"]> = {
    read: fs.read ?? null,
    write: null,
  };
  if (fs.entries?.length) grant.entries = fs.entries;
  return grant;
}

/** Supported CLI minor: 0.164 (native-smoke tested on 0.164.0). Constructor options are a trusted subprocess test seam. */
export class SkillCodexSession {
  private current: SkillCodexState = {
    status: "idle",
    messages: [],
    approvals: [],
  };
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<Id, Pending>();
  private sequence = 0;
  private turnId?: string;
  private ready = false;
  private closed = false;
  private closing = false;
  private interrupting = false;
  private stopping?: Promise<void>;
  private starting?: Promise<void>;
  private messageItems = new Map<string, number>();
  private fileItems = new Map<string, JsonObject[]>();
  private accessGrants = new Map<Id, AccessGrant>();
  private executions = new Map<Id, Execution>();
  private activeCommand?: { id: Id; processId: string; turnId: string };
  private commandDone?: Promise<void>;
  readonly workdir: string;
  readonly metadataPath: string;

  constructor(
    workdir: string,
    metadataPath: string,
    private options: { command?: string[]; requestTimeoutMs?: number } = {}
  ) {
    this.workdir = realpathSync(workdir);
    this.metadataPath = metadataFile(this.workdir, metadataPath);
    const saved = readSession(this.metadataPath);
    if (saved) this.current = { ...this.current, ...saved };
  }

  state(): SkillCodexState {
    return structuredClone(this.current);
  }

  async start(prompt: string): Promise<SkillCodexState> {
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("A prompt is required");
    if (Buffer.byteLength(prompt) > 100_000)
      throw new Error("prompt は 100KB 以下にしてください。");
    if (this.closed || this.closing)
      throw new Error("Codex session is shut down");
    if (!["idle", "failed"].includes(this.current.status))
      throw new Error("Codex session is busy");
    this.current.status = "starting";
    delete this.current.error;
    this.starting = this.begin(prompt);
    try {
      await this.starting;
      return this.state();
    } catch (error) {
      if (!this.closed) {
        this.fail(error);
        throw new Error(this.current.error);
      }
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  private async prepare(): Promise<void> {
    if (this.stopping) {
      this.child = undefined;
      await this.stopping;
      this.stopping = undefined;
      this.ready = false;
    }
    if (this.closed) throw new Error("Codex session is shut down");
    this.interrupting = false;
    if (!this.ready) await this.initialize();
  }

  private async begin(prompt: string): Promise<void> {
    await this.prepare();
    if (this.closed) throw new Error("Codex session is shut down");
    this.messageItems.clear();
    this.fileItems.clear();
    this.current.messages.push({ role: "user", text: prompt });
    this.persist();
    this.current.status = "running";
    // CLI 0.164.0 needs an explicit policy; a named profile alone did not confine command/exec.
    const result = await this.request("turn/start", {
      threadId: this.current.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: this.workdir,
      runtimeWorkspaceRoots: [this.workdir],
      approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy,
      environments: [],
    });
    if (!object(result?.turn) || typeof result.turn.id !== "string")
      throw new Error("Invalid turn/start response");
    // Completion notifications may arrive before the turn/start response is consumed.
    if (this.current.status === "running" || this.current.status === "approval")
      this.turnId = result.turn.id;
  }

  private async initializeConfig(
    config: Record<string, unknown>
  ): Promise<void> {
    let effective = await this.open(config);
    this.checkConfig(effective.config, true);
    const inherited = Object.entries(effective.config.mcp_servers).filter(
      ([, value]) => (value as JsonObject).enabled !== false
    );
    if (inherited.length) {
      for (const [name] of inherited) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name))
          throw new Error(
            "Unsupported inherited MCP server name; cannot prove isolation"
          );
        config[`mcp_servers.${name}.enabled`] = false;
      }
      // Config tables merge: restart with per-server overrides before loading any thread.
      const stopping = this.stop();
      this.child = undefined;
      await stopping;
      this.stopping = undefined;
      if (this.closed) throw new Error("Codex session is shut down");
      effective = await this.open(config);
    }
    this.checkConfig(effective.config);
  }

  private safeWorkspaceRoots(value: unknown): boolean {
    return Array.isArray(value) && value.every((root) => root === this.workdir);
  }

  private safeThreadWorkspace(thread: unknown): thread is JsonObject {
    return (
      object(thread) &&
      object(thread.thread) &&
      typeof thread.thread.id === "string" &&
      thread.cwd === this.workdir &&
      this.safeWorkspaceRoots(thread.runtimeWorkspaceRoots)
    );
  }

  private safeBootstrapSandbox(value: unknown): boolean {
    return (
      this.safeSandbox(value) ||
      (object(value) &&
        value.type === "readOnly" &&
        value.networkAccess === false)
    );
  }

  private confirmThread(thread: unknown): void {
    if (
      !this.safeThreadWorkspace(thread) ||
      thread.approvalsReviewer !== "user" ||
      !safeApprovalPolicy(thread.approvalPolicy) ||
      !this.safeBootstrapSandbox(thread.sandbox)
    )
      throw new Error("Codex did not confirm workcopy-only isolation");
    this.current.threadId = thread.thread.id;
    this.persist();
    this.ready = true;
  }

  private async initialize(): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Codex isolation requires macOS or Linux");
    const config = isolationConfig();
    await this.initializeConfig(config);
    const thread = await this.request(
      this.current.threadId ? "thread/resume" : "thread/start",
      {
        ...(this.current.threadId
          ? { threadId: this.current.threadId }
          : {
              ephemeral: false,
              environments: [],
              dynamicTools: [executeTool],
            }),
        cwd: this.workdir,
        runtimeWorkspaceRoots: [this.workdir],
        sandbox: "workspace-write",
        approvalPolicy,
        approvalsReviewer: "user",
        config,
      }
    );
    this.confirmThread(thread);
  }

  private async open(config: Record<string, unknown>): Promise<JsonObject> {
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      ...Object.entries(config).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
    ];
    const env = Object.fromEntries(
      ["HOME", "PATH", "CODEX_HOME", "LANG", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : []
      )
    );
    const [command, ...prefix] = this.options.command ?? ["codex"];
    const child = spawn(command!, [...prefix, ...args], {
      cwd: this.workdir,
      env,
      detached: true,
      stdio: "pipe",
    });
    this.child = child;
    child.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.stdin.on("error", (error) => {
      if (this.child === child && !this.closed) this.fail(error);
    });
    // Drain diagnostics without exposing login data or arbitrary stderr to the UI.
    child.stderr.resume();
    child.on("exit", (code, signal) => {
      if (
        this.child === child &&
        !this.closed &&
        this.current.status !== "failed"
      )
        this.fail(new Error(`Codex app-server exited (${signal ?? code})`));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (
        this.child !== child ||
        this.closed ||
        this.current.status === "failed"
      )
        return;
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        this.fail(error);
      }
    });
    lines.on("close", () => {
      if (
        this.child === child &&
        !this.closed &&
        this.current.status !== "failed"
      )
        this.fail(new Error("Codex app-server closed stdout"));
    });
    const initialized = await this.request("initialize", {
      clientInfo: { name: "skill_loom", title: "Skill Loom", version: "1" },
      capabilities: { experimentalApi: true },
    });
    // Native 0.164 reports `<clientInfo.name>/<CLI version> ...` before any account or thread request.
    if (
      typeof initialized?.userAgent !== "string" ||
      !/^skill_loom\/0\.164\.\d+(?:\s|$)/.test(initialized.userAgent)
    ) {
      throw new Error(
        "対応する Codex CLI は 0.164.x です。隔離方式を検証できないバージョンのため開始しません。"
      );
    }
    this.send({ method: "initialized" });
    const account = await this.request("account/read", { refreshToken: false });
    if (account?.account?.type !== "chatgpt") {
      throw new Error(
        "ChatGPT のログインが必要です。ターミナルで codex login を実行し、ChatGPT でログインしてから再度開始してください。"
      );
    }
    return this.request("config/read", {
      cwd: this.workdir,
      includeLayers: false,
    });
  }

  private safeSandboxConfig(config: JsonObject): boolean {
    const sandbox = config.sandbox_workspace_write;
    return (
      config.sandbox_mode === "workspace-write" &&
      object(sandbox) &&
      this.safeSandbox({
        type: "workspaceWrite",
        writableRoots: sandbox.writable_roots,
        networkAccess: sandbox.network_access,
        excludeTmpdirEnvVar: sandbox.exclude_tmpdir_env_var,
        excludeSlashTmp: sandbox.exclude_slash_tmp,
      })
    );
  }

  private checkConfig(config: unknown, allowInheritedMcp = false): void {
    if (
      !object(config) ||
      !safeFeatures(config.features) ||
      !safeRuntimeConfig(config) ||
      !this.safeSandboxConfig(config) ||
      !safeMcpConfig(config.mcp_servers, allowInheritedMcp)
    )
      throw new Error(
        "Codex isolation could not disable inherited MCPs, plugins, hooks or notifications"
      );
  }

  private safeSandbox(value: unknown): boolean {
    return (
      object(value) &&
      value.type === "workspaceWrite" &&
      Array.isArray(value.writableRoots) &&
      value.writableRoots.every((path: unknown) => path === this.workdir) &&
      value.networkAccess === false &&
      value.excludeTmpdirEnvVar === true &&
      value.excludeSlashTmp === true
    );
  }

  private persist(): void {
    const temporary = `${this.metadataPath}.tmp-${randomUUID()}`;
    writeFileSync(
      temporary,
      JSON.stringify({
        threadId: this.current.threadId,
        messages: this.current.messages,
      }),
      { mode: 0o600, flag: "wx" }
    );
    renameSync(temporary, this.metadataPath);
  }

  private send(message: JsonObject): void {
    if (this.closed || !this.child || this.child.stdin.destroyed)
      throw new Error("Codex app-server is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: JsonObject): Promise<any> {
    if (this.closed || this.current.status === "failed")
      return Promise.reject(
        new Error(this.current.error ?? "Codex session is shut down")
      );
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.fail(new Error(`Codex ${method} timed out`)),
        this.options.requestTimeoutMs ?? 15_000
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  private receive(message: unknown): void {
    if (!object(message)) throw new Error("Invalid Codex JSON-RPC message");
    if (typeof message.method !== "string") {
      this.receiveResponse(message);
    } else if (message.id !== undefined) {
      this.receiveRequest(message.id, message.method, message.params);
    } else {
      this.receiveNotification(message.method, message.params);
    }
  }

  private receiveResponse(message: JsonObject): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(
        new Error(message.error.message ?? "Codex request failed")
      );
    else pending.resolve(message.result);
  }

  private scopedRequest(method: string, params: unknown): params is TurnParams {
    return (
      approvalMethods.includes(method as ApprovalMethod) &&
      object(params) &&
      params.threadId === this.current.threadId &&
      typeof params.turnId === "string"
    );
  }

  private activeTurn(turnId: string): boolean {
    return (
      ["running", "approval"].includes(this.current.status) &&
      (!this.turnId || turnId === this.turnId)
    );
  }

  private receiveRequest(id: unknown, method: string, params: unknown): void {
    if (typeof id !== "number" && typeof id !== "string")
      throw new Error("Invalid Codex approval ID");
    if (!this.scopedRequest(method, params)) {
      this.refuse(
        id,
        method,
        object(params) ? params : {},
        "この種類の要求は未対応のため承認できません。",
        false
      );
      return;
    }
    if (!this.activeTurn(params.turnId)) {
      this.refuse(
        id,
        method,
        params,
        "既に終了した、または現在の実行とは異なる turn の要求です。",
        true
      );
      return;
    }
    this.turnId = params.turnId;
    this.dispatchApproval({ id, method: method as ApprovalMethod, params });
  }

  private dispatchApproval(request: ApprovalRequest): void {
    const { id, method, params } = request;
    switch (method) {
      case "item/tool/call":
        this.receiveExecution(id, params);
        break;
      case "item/permissions/requestApproval":
        this.receivePermissions(id, params);
        break;
      case "item/commandExecution/requestApproval":
        this.receiveCommandApproval(id, params);
        break;
      case "item/fileChange/requestApproval":
        this.receiveFileApproval(id, params);
        break;
    }
  }

  private queueApproval(id: Id, title: string, detail: string): void {
    this.current.approvals.push({ id, title, detail });
    this.current.status = "approval";
  }

  private receiveExecution(id: Id, p: TurnParams): void {
    const args = p.arguments;
    if (
      this.closing ||
      p.tool !== "skill_exec" ||
      p.namespace != null ||
      typeof p.callId !== "string" ||
      !toolArguments(args)
    ) {
      this.refuse(
        id,
        "item/tool/call",
        p,
        "未対応または不正な command tool の要求です。",
        false
      );
      return;
    }
    this.executions.set(id, {
      argv: [...args.argv],
      network: args.network === true,
    });
    this.queueApproval(
      id,
      "コマンドの実行許可",
      `argv: ${JSON.stringify(args.argv)}\ncwd: ${this.workdir}\nネットワーク: ${args.network === true ? "許可を要求" : "禁止"}`
    );
  }

  private receivePermissions(id: Id, p: TurnParams): void {
    const grant = this.accessGrant(p.permissions);
    if (!grant || p.environmentId != null || !this.safePath(p.cwd)) {
      this.refuse(
        id,
        "item/permissions/requestApproval",
        p,
        "追加 write・glob・特殊パス・別環境への権限は許可できません。",
        true
      );
      return;
    }
    this.accessGrants.set(id, grant);
    this.queueApproval(
      id,
      "追加アクセスの許可",
      `${p.reason ?? "追加データまたはネットワークへのアクセス"}\n${JSON.stringify(p.permissions, null, 2)}`
    );
  }

  private receiveCommandApproval(id: Id, p: TurnParams): void {
    // Accept must never grant a sandbox escape or a new writable root.
    if (
      p.additionalPermissions ||
      p.networkApprovalContext ||
      p.proposedExecpolicyAmendment ||
      p.proposedNetworkPolicyAmendments ||
      typeof p.cwd !== "string" ||
      !this.safePath(p.cwd)
    ) {
      this.refuseOutsideAccess(id, "item/commandExecution/requestApproval", p);
      return;
    }
    this.queueApproval(id, "Command execution", this.approvalDetail(p));
  }

  private safeFileChange(change: JsonObject): boolean {
    return (
      this.safePath(change.path) &&
      (change.kind?.move_path == null || this.safePath(change.kind.move_path))
    );
  }

  private receiveFileApproval(id: Id, p: TurnParams): void {
    const changes = this.fileItems.get(p.itemId);
    if (
      p.grantRoot != null ||
      !changes?.length ||
      !changes.every((change) => this.safeFileChange(change))
    ) {
      this.refuseOutsideAccess(id, "item/fileChange/requestApproval", p);
      return;
    }
    this.queueApproval(id, "File changes", this.approvalDetail(p, changes));
  }

  private refuseOutsideAccess(
    id: Id,
    method: ApprovalMethod,
    p: TurnParams
  ): void {
    this.refuse(
      id,
      method,
      p,
      "作業ディレクトリ外へのアクセスや追加権限の要求は承認できません。",
      true
    );
  }

  private approvalDetail(p: TurnParams, changes: JsonObject[] = []): string {
    return [
      p.command,
      p.cwd,
      p.reason,
      p.itemId,
      ...changes.map((change) => `${change.path}\n${change.diff}`),
    ]
      .filter((v) => typeof v === "string")
      .join("\n");
  }

  private receiveNotification(method: string, params: unknown): void {
    if (!object(params) || params.threadId !== this.current.threadId) return;
    if (!this.receiveThreadEvent({ method, params }))
      this.receiveTurnNotification(method, params);
  }

  private receiveThreadEvent({ method, params }: Notification): boolean {
    if (method === "error") {
      if (!params.willRetry)
        this.fail(new Error(params.error?.message ?? "Codex turn failed"));
      return true;
    }
    if (method === "serverRequest/resolved") {
      this.resolveApproval(params.requestId);
      return true;
    }
    return false;
  }

  private receiveTurnNotification(method: string, params: JsonObject): void {
    const turnId =
      method === "turn/started" || method === "turn/completed"
        ? params.turn?.id
        : params.turnId;
    if (typeof turnId !== "string" || !this.activeTurn(turnId)) return;
    this.turnId = turnId;
    if (turnEventMethod(method)) this.dispatchTurnEvent({ method, params });
  }

  private resolveApproval(id: Id): void {
    this.accessGrants.delete(id);
    this.executions.delete(id);
    this.current.approvals = this.current.approvals.filter((a) => a.id !== id);
    if (this.current.status === "approval" && !this.current.approvals.length)
      this.current.status = "running";
  }

  private dispatchTurnEvent({ method, params }: TurnEvent): void {
    switch (method) {
      case "item/started":
        if (params.item?.type === "fileChange")
          this.receiveFileChanges(params.item);
        break;
      case "item/agentMessage/delta":
        this.receiveMessageDelta(params);
        break;
      case "item/completed":
        if (params.item?.type === "agentMessage")
          this.receiveMessage(params.item);
        break;
      case "turn/completed":
        this.completeTurn(params.turn);
        break;
    }
  }

  private receiveFileChanges(item: JsonObject): void {
    if (
      typeof item.id !== "string" ||
      !Array.isArray(item.changes) ||
      item.changes.some(
        (change: unknown) =>
          !object(change) ||
          typeof change.path !== "string" ||
          typeof change.diff !== "string"
      )
    )
      throw new Error("Invalid Codex file changes");
    this.fileItems.set(item.id, item.changes);
  }

  private receiveMessageDelta(p: JsonObject): void {
    if (typeof p.itemId !== "string" || typeof p.delta !== "string")
      throw new Error("Invalid Codex message delta");
    this.message(p.itemId, p.delta, true);
  }

  private receiveMessage(item: JsonObject): void {
    if (typeof item.id !== "string" || typeof item.text !== "string")
      throw new Error("Invalid Codex agent message");
    this.message(item.id, item.text, false);
  }

  private completeTurn(turn: JsonObject): void {
    this.turnId = undefined;
    this.current.approvals = [];
    this.accessGrants.clear();
    this.executions.clear();
    if (turn.status === "failed")
      this.fail(new Error(turn.error?.message ?? "Codex turn failed"));
    else {
      this.current.status = "idle";
      this.persist();
    }
  }

  private refuse(
    id: Id,
    method: string,
    params: JsonObject,
    reason: string,
    approval: boolean
  ): void {
    this.send(
      method === "item/tool/call"
        ? {
            id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: reason }],
            },
          }
        : method === "item/permissions/requestApproval"
          ? { id, result: { permissions: {}, scope: "turn" } }
          : approval
            ? { id, result: { decision: "decline" } }
            : {
                id,
                error: {
                  code: -32601,
                  message: "Unsupported Codex server request",
                },
              }
    );
    const detail = [
      params.command,
      params.cwd,
      params.reason,
      params.itemId,
      ...(method === "item/tool/call"
        ? [params.tool, JSON.stringify(params.arguments)]
        : []),
      ...(method === "item/permissions/requestApproval"
        ? [JSON.stringify(params.permissions)]
        : []),
    ]
      .filter((value) => typeof value === "string")
      .map((value) => value.slice(0, 4096))
      .join("\n");
    this.current.messages.push({
      role: "system",
      text: `ポリシーにより要求を拒否しました: ${method}\n${reason}${detail ? `\n${detail}` : ""}`,
    });
    this.persist();
  }

  private accessGrant(value: unknown): AccessGrant | null {
    if (!requestedPermissions(value)) return null;
    const grant: AccessGrant = {};
    if (value.network?.enabled === true) grant.network = { enabled: true };
    if (value.fileSystem != null) {
      const fileSystem = fileReadGrant(value.fileSystem);
      if (fileSystem) grant.fileSystem = fileSystem;
    }
    return Object.keys(grant).length ? grant : null;
  }

  private safePath(path: unknown): boolean {
    if (typeof path !== "string") return false;
    let existing = resolve(this.workdir, path);
    if (!inside(this.workdir, existing)) return false;
    while (!existsSync(existing)) {
      if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink())
        return false;
      existing = dirname(existing);
    }
    return inside(this.workdir, realpathSync(existing));
  }

  private message(id: string, text: string, append: boolean): void {
    let index = this.messageItems.get(id);
    if (index === undefined) {
      index = this.current.messages.length;
      this.messageItems.set(id, index);
      this.current.messages.push({ role: "assistant", text: "" });
    }
    this.current.messages[index]!.text = append
      ? this.current.messages[index]!.text + text
      : text;
    this.persist();
  }

  async approve(
    id: Id,
    decision: "accept" | "decline"
  ): Promise<SkillCodexState> {
    this.checkApproval(id, decision);
    const execution = this.executions.get(id);
    if (execution && decision === "accept" && this.activeCommand)
      throw new Error("別のコマンドを実行中です。完了後に承認してください。");
    this.replyApproval(id, decision, execution);
    this.accessGrants.delete(id);
    this.executions.delete(id);
    this.current.approvals = this.current.approvals.filter((a) => a.id !== id);
    this.current.status = this.current.approvals.length
      ? "approval"
      : "running";
    if (execution && decision === "accept") {
      this.startCommand(id, execution);
    }
    return this.state();
  }

  private checkApproval(id: Id, decision: "accept" | "decline"): void {
    if (decision !== "accept" && decision !== "decline")
      throw new Error("Invalid Codex approval decision");
    if (!this.current.approvals.some((a) => a.id === id))
      throw new Error("Unknown or expired Codex approval");
    if (this.closing || this.interrupting)
      throw new Error("Codex は終了または中断処理中です。");
  }

  private replyApproval(
    id: Id,
    decision: "accept" | "decline",
    execution?: Execution
  ): void {
    const grant = this.accessGrants.get(id);
    if (!execution)
      this.send({
        id,
        result: grant
          ? { permissions: decision === "accept" ? grant : {}, scope: "turn" }
          : { decision },
      });
    else if (decision === "decline")
      this.send({
        id,
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "ユーザーがコマンド実行を拒否しました。",
            },
          ],
        },
      });
  }

  private startCommand(id: Id, execution: Execution): void {
    const done = this.runCommand(id, execution).catch((error) =>
      this.fail(error)
    );
    this.commandDone = done;
    void done.finally(() => {
      if (this.commandDone === done) this.commandDone = undefined;
    });
  }

  private async runCommand(id: Id, execution: Execution): Promise<void> {
    const active = {
      id,
      processId: `skill-loom-${randomUUID()}`,
      turnId: this.turnId!,
    };
    this.activeCommand = active;
    try {
      const result = await this.request("command/exec", {
        command: execution.argv,
        cwd: this.workdir,
        processId: active.processId,
        timeoutMs: 10_000,
        outputBytesCap: 65_536,
        sandboxPolicy: {
          ...sandboxPolicy,
          writableRoots: [this.workdir],
          networkAccess: execution.network,
        },
      });
      if (
        !this.closed &&
        !this.closing &&
        !this.interrupting &&
        this.current.status !== "failed" &&
        this.turnId === active.turnId
      ) {
        this.send({
          id,
          result: {
            success: result?.exitCode === 0,
            contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          },
        });
      }
    } finally {
      if (this.activeCommand === active) this.activeCommand = undefined;
    }
  }

  async interrupt(): Promise<SkillCodexState> {
    this.interrupting = true;
    if (this.starting && !this.turnId) {
      this.fail(new Error("Codex の起動を中断しました。"));
      await this.stop();
      return this.state();
    }
    try {
      if (this.starting) await this.starting;
      if (this.activeCommand)
        await this.request("command/exec/terminate", {
          processId: this.activeCommand.processId,
        });
      await this.commandDone;
      if (this.turnId)
        await this.request("turn/interrupt", {
          threadId: this.current.threadId,
          turnId: this.turnId,
        });
    } catch (error) {
      this.fail(error);
      throw error;
    }
    return this.state();
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: unknown): void {
    if (this.closed || this.current.status === "failed") return;
    this.current.status = "failed";
    this.current.error = `${errorMessage(error)}\n再度開始すると Codex を再起動して会話を再開します。`;
    this.current.approvals = [];
    this.accessGrants.clear();
    this.executions.clear();
    this.turnId = undefined;
    this.rejectPending(new Error(this.current.error));
    void this.stop();
  }

  private stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      const child = this.child;
      if (!child?.pid) return;
      stoppingWorkdirs.add(this.workdir);
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            child.kill(signal);
        }
      };
      child.stdin.end();
      kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      // The server may have exited while one of its commands still owns a pipe.
      kill("SIGKILL");
      stoppingWorkdirs.delete(this.workdir);
    })());
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (
      this.activeCommand &&
      !this.closed &&
      this.current.status !== "failed"
    ) {
      try {
        await this.request("command/exec/terminate", {
          processId: this.activeCommand.processId,
        });
      } catch (error) {
        this.fail(error);
      }
      await this.commandDone;
    }
    this.closed = true;
    this.rejectPending(new Error("Codex session is shut down"));
    this.current.approvals = [];
    this.accessGrants.clear();
    this.executions.clear();
    this.turnId = undefined;
    if (this.current.status !== "failed") this.current.status = "idle";
    await this.stop();
    if (sessions.get(this.workdir) === this) sessions.delete(this.workdir);
  }
}

const sessions = new Map<string, SkillCodexSession>();
const stoppingWorkdirs = new Set<string>();

export function getSkillCodexSession(
  workdir: string,
  metadataPath: string
): SkillCodexSession {
  const key = realpathSync(workdir);
  let session = sessions.get(key);
  if (
    session &&
    session.metadataPath !==
      resolve(
        realpathSync(dirname(resolve(metadataPath))),
        basename(metadataPath)
      )
  )
    throw new Error("Workcopy already has a different Codex metadata path");
  if (!session) {
    session = new SkillCodexSession(key, metadataPath);
    sessions.set(key, session);
  }
  return session;
}

export function isSkillCodexBusy(workdir: string): boolean {
  const key = realpathSync(workdir);
  if (stoppingWorkdirs.has(key)) return true;
  const session = sessions.get(key);
  return session
    ? ["starting", "running", "approval"].includes(session.state().status)
    : false;
}

export async function shutdownAllSkillCodexSessions(): Promise<void> {
  const owned = [...sessions.values()];
  sessions.clear();
  await Promise.all(owned.map((session) => session.shutdown()));
}

export async function shutdownSkillCodexSession(
  workdir: string
): Promise<void> {
  await sessions.get(realpathSync(workdir))?.shutdown();
}
