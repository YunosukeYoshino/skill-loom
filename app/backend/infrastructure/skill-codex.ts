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
  private accessGrants = new Map<Id, JsonObject>();
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
    const target = resolve(metadataPath);
    if (inside(this.workdir, target))
      throw new Error("Codex metadata must be outside the workcopy");
    let existingParent = dirname(target);
    while (!existsSync(existingParent))
      existingParent = dirname(existingParent);
    if (inside(this.workdir, realpathSync(existingParent)))
      throw new Error("Codex metadata must be outside the workcopy");
    mkdirSync(dirname(target), { recursive: true });
    this.metadataPath = resolve(
      realpathSync(dirname(target)),
      basename(target)
    );
    if (
      inside(this.workdir, this.metadataPath) ||
      (existsSync(target) && lstatSync(target).isSymbolicLink())
    ) {
      throw new Error(
        "Codex metadata must be outside the workcopy and not a symlink"
      );
    }
    if (existsSync(this.metadataPath)) {
      const saved: unknown = JSON.parse(
        readFileSync(this.metadataPath, "utf8")
      );
      if (
        !object(saved) ||
        (saved.threadId !== undefined && typeof saved.threadId !== "string") ||
        !Array.isArray(saved.messages) ||
        saved.messages.some(
          (m: unknown) =>
            !object(m) ||
            !["user", "assistant", "system"].includes(m.role) ||
            typeof m.text !== "string"
        )
      ) {
        throw new Error("Invalid Codex session metadata");
      }
      this.current.threadId = saved.threadId;
      this.current.messages = saved.messages.map(({ role, text }) => ({
        role,
        text,
      }));
    }
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

  private async begin(prompt: string): Promise<void> {
    if (this.stopping) {
      this.child = undefined;
      await this.stopping;
      this.stopping = undefined;
      this.ready = false;
    }
    if (this.closed) throw new Error("Codex session is shut down");
    this.interrupting = false;
    if (!this.ready) await this.initialize();
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

  private async initialize(): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Codex isolation requires macOS or Linux");
    const config: Record<string, unknown> = {
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
    if (
      !object(thread?.thread) ||
      typeof thread.thread.id !== "string" ||
      thread.cwd !== this.workdir ||
      !Array.isArray(thread.runtimeWorkspaceRoots) ||
      thread.runtimeWorkspaceRoots.some(
        (root: unknown) => root !== this.workdir
      ) ||
      thread.approvalsReviewer !== "user" ||
      !safeApprovalPolicy(thread.approvalPolicy) ||
      !(
        this.safeSandbox(thread.sandbox) ||
        (thread.sandbox?.type === "readOnly" &&
          thread.sandbox.networkAccess === false)
      )
    ) {
      throw new Error("Codex did not confirm workcopy-only isolation");
    }
    this.current.threadId = thread.thread.id;
    this.persist();
    this.ready = true;
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

  private checkConfig(config: unknown, allowInheritedMcp = false): void {
    if (
      !object(config) ||
      !object(config.features) ||
      disabledFeatures.some((key) => config.features[key] !== false) ||
      !Array.isArray(config.notify) ||
      config.notify.length ||
      config.model_provider !== "openai" ||
      config.sandbox_mode !== "workspace-write" ||
      !object(config.sandbox_workspace_write) ||
      !this.safeSandbox({
        type: "workspaceWrite",
        writableRoots: config.sandbox_workspace_write.writable_roots,
        networkAccess: config.sandbox_workspace_write.network_access,
        excludeTmpdirEnvVar:
          config.sandbox_workspace_write.exclude_tmpdir_env_var,
        excludeSlashTmp: config.sandbox_workspace_write.exclude_slash_tmp,
      }) ||
      !safeApprovalPolicy(config.approval_policy) ||
      config.approvals_reviewer !== "user" ||
      config.allow_login_shell !== false ||
      config.web_search !== "disabled" ||
      config.features.request_permissions_tool !== true ||
      config.shell_environment_policy?.inherit !== "none" ||
      config.shell_environment_policy?.experimental_use_profile !== false ||
      !object(config.shell_environment_policy?.set) ||
      Object.keys(config.shell_environment_policy.set).length !== 0 ||
      !object(config.mcp_servers) ||
      Object.values(config.mcp_servers).some(
        (value) =>
          !object(value) || (!allowInheritedMcp && value.enabled !== false)
      )
    ) {
      throw new Error(
        "Codex isolation could not disable inherited MCPs, plugins, hooks or notifications"
      );
    }
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
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(message.error.message ?? "Codex request failed")
        );
      else pending.resolve(message.result);
      return;
    }
    const p = message.params;
    if (message.id !== undefined) {
      if (typeof message.id !== "number" && typeof message.id !== "string")
        throw new Error("Invalid Codex approval ID");
      if (
        object(p) &&
        p.threadId === this.current.threadId &&
        typeof p.turnId === "string" &&
        (message.method === "item/commandExecution/requestApproval" ||
          message.method === "item/fileChange/requestApproval" ||
          message.method === "item/permissions/requestApproval" ||
          message.method === "item/tool/call")
      ) {
        if (
          !["running", "approval"].includes(this.current.status) ||
          (this.turnId && p.turnId !== this.turnId)
        ) {
          this.refuse(
            message.id,
            message.method,
            p,
            "既に終了した、または現在の実行とは異なる turn の要求です。",
            true
          );
          return;
        }
        this.turnId = p.turnId;
        if (message.method === "item/tool/call") {
          const args = p.arguments;
          if (
            this.closing ||
            p.tool !== "skill_exec" ||
            p.namespace != null ||
            typeof p.callId !== "string" ||
            !object(args) ||
            Object.keys(args).some(
              (key) => !["argv", "network"].includes(key)
            ) ||
            !Array.isArray(args.argv) ||
            !args.argv.length ||
            args.argv.length > 256 ||
            args.argv.some(
              (arg: unknown) => typeof arg !== "string" || arg.includes("\0")
            ) ||
            !args.argv[0] ||
            Buffer.byteLength(JSON.stringify(args.argv)) > 100_000 ||
            (args.network !== undefined && typeof args.network !== "boolean")
          ) {
            this.refuse(
              message.id,
              message.method,
              p,
              "未対応または不正な command tool の要求です。",
              false
            );
            return;
          }
          this.executions.set(message.id, {
            argv: [...args.argv],
            network: args.network === true,
          });
          this.current.approvals.push({
            id: message.id,
            title: "コマンドの実行許可",
            detail: `argv: ${JSON.stringify(args.argv)}\ncwd: ${this.workdir}\nネットワーク: ${args.network === true ? "許可を要求" : "禁止"}`,
          });
          this.current.status = "approval";
          return;
        }
        if (message.method === "item/permissions/requestApproval") {
          const grant = this.accessGrant(p.permissions);
          if (!grant || p.environmentId != null || !this.safePath(p.cwd)) {
            this.refuse(
              message.id,
              message.method,
              p,
              "追加 write・glob・特殊パス・別環境への権限は許可できません。",
              true
            );
            return;
          }
          this.accessGrants.set(message.id, grant);
          this.current.approvals.push({
            id: message.id,
            title: "追加アクセスの許可",
            detail: `${p.reason ?? "追加データまたはネットワークへのアクセス"}\n${JSON.stringify(p.permissions, null, 2)}`,
          });
          this.current.status = "approval";
          return;
        }
        const command =
          message.method === "item/commandExecution/requestApproval";
        const changes = this.fileItems.get(p.itemId);
        // Accept must never grant a sandbox escape or a new writable root.
        if (
          (command &&
            (p.additionalPermissions ||
              p.networkApprovalContext ||
              p.proposedExecpolicyAmendment ||
              p.proposedNetworkPolicyAmendments ||
              typeof p.cwd !== "string" ||
              !this.safePath(p.cwd))) ||
          (!command &&
            (p.grantRoot != null ||
              !changes?.length ||
              changes.some(
                (change) =>
                  !this.safePath(change.path) ||
                  (change.kind?.move_path != null &&
                    !this.safePath(change.kind.move_path))
              )))
        ) {
          this.refuse(
            message.id,
            message.method,
            p,
            "作業ディレクトリ外へのアクセスや追加権限の要求は承認できません。",
            true
          );
          return;
        }
        this.current.approvals.push({
          id: message.id,
          title: command ? "Command execution" : "File changes",
          detail: [
            p.command,
            p.cwd,
            p.reason,
            p.itemId,
            ...(!command
              ? changes!.map((change) => `${change.path}\n${change.diff}`)
              : []),
          ]
            .filter((v) => typeof v === "string")
            .join("\n"),
        });
        this.current.status = "approval";
      } else {
        this.refuse(
          message.id,
          message.method,
          object(p) ? p : {},
          "この種類の要求は未対応のため承認できません。",
          false
        );
      }
      return;
    }
    if (!object(p) || p.threadId !== this.current.threadId) return;
    if (message.method === "error") {
      if (!p.willRetry)
        this.fail(new Error(p.error?.message ?? "Codex turn failed"));
      return;
    }
    if (message.method === "serverRequest/resolved") {
      this.accessGrants.delete(p.requestId);
      this.executions.delete(p.requestId);
      this.current.approvals = this.current.approvals.filter(
        (a) => a.id !== p.requestId
      );
      if (this.current.status === "approval" && !this.current.approvals.length)
        this.current.status = "running";
      return;
    }
    const incomingTurn =
      message.method === "turn/started" || message.method === "turn/completed"
        ? p.turn?.id
        : p.turnId;
    if (
      typeof incomingTurn !== "string" ||
      (this.turnId && incomingTurn !== this.turnId) ||
      !["running", "approval"].includes(this.current.status)
    )
      return;
    this.turnId = incomingTurn;
    if (message.method === "item/started" && p.item?.type === "fileChange") {
      if (
        typeof p.item.id !== "string" ||
        !Array.isArray(p.item.changes) ||
        p.item.changes.some(
          (change: unknown) =>
            !object(change) ||
            typeof change.path !== "string" ||
            typeof change.diff !== "string"
        )
      ) {
        throw new Error("Invalid Codex file changes");
      }
      this.fileItems.set(p.item.id, p.item.changes);
    } else if (message.method === "item/agentMessage/delta") {
      if (typeof p.itemId !== "string" || typeof p.delta !== "string")
        throw new Error("Invalid Codex message delta");
      this.message(p.itemId, p.delta, true);
    } else if (
      message.method === "item/completed" &&
      p.item?.type === "agentMessage"
    ) {
      if (typeof p.item.id !== "string" || typeof p.item.text !== "string")
        throw new Error("Invalid Codex agent message");
      this.message(p.item.id, p.item.text, false);
    } else if (message.method === "turn/completed") {
      this.turnId = undefined;
      this.current.approvals = [];
      this.accessGrants.clear();
      this.executions.clear();
      if (p.turn.status === "failed") {
        this.fail(new Error(p.turn.error?.message ?? "Codex turn failed"));
      } else {
        this.current.status = "idle";
        this.persist();
      }
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

  private accessGrant(value: unknown): JsonObject | null {
    if (
      !object(value) ||
      Object.keys(value).some((key) => !["network", "fileSystem"].includes(key))
    )
      return null;
    const grant: JsonObject = {};
    if (value.network != null) {
      if (
        !object(value.network) ||
        Object.keys(value.network).some((key) => key !== "enabled") ||
        (value.network.enabled !== null &&
          typeof value.network.enabled !== "boolean")
      )
        return null;
      if (value.network.enabled === true) grant.network = { enabled: true };
    }
    if (value.fileSystem != null) {
      const fs = value.fileSystem;
      const readPath = (path: unknown) =>
        typeof path === "string" && isAbsolute(path) && !/[*?\[\]]/.test(path);
      if (
        !object(fs) ||
        Object.keys(fs).some(
          (key) =>
            !["read", "write", "entries", "globScanMaxDepth"].includes(key)
        ) ||
        (fs.write != null &&
          (!Array.isArray(fs.write) || fs.write.length !== 0)) ||
        (fs.read != null &&
          (!Array.isArray(fs.read) || !fs.read.every(readPath))) ||
        (fs.entries != null &&
          (!Array.isArray(fs.entries) ||
            fs.entries.some(
              (entry: unknown) =>
                !object(entry) ||
                entry.access !== "read" ||
                !object(entry.path) ||
                entry.path.type !== "path" ||
                !readPath(entry.path.path)
            )))
      )
        return null;
      if (fs.read?.length || fs.entries?.length)
        grant.fileSystem = {
          read: fs.read ?? null,
          write: null,
          ...(fs.entries?.length ? { entries: fs.entries } : {}),
        };
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
    if (decision !== "accept" && decision !== "decline")
      throw new Error("Invalid Codex approval decision");
    if (!this.current.approvals.some((a) => a.id === id))
      throw new Error("Unknown or expired Codex approval");
    if (this.closing || this.interrupting)
      throw new Error("Codex は終了または中断処理中です。");
    const execution = this.executions.get(id);
    if (execution && decision === "accept" && this.activeCommand)
      throw new Error("別のコマンドを実行中です。完了後に承認してください。");
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
    this.accessGrants.delete(id);
    this.executions.delete(id);
    this.current.approvals = this.current.approvals.filter((a) => a.id !== id);
    this.current.status = this.current.approvals.length
      ? "approval"
      : "running";
    if (execution && decision === "accept") {
      const done = this.runCommand(id, execution).catch((error) =>
        this.fail(error)
      );
      this.commandDone = done;
      void done.finally(() => {
        if (this.commandDone === done) this.commandDone = undefined;
      });
    }
    return this.state();
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
