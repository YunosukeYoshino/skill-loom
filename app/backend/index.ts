#!/usr/bin/env bun
/**
 * 公開ポートの入口。Hono がポートと SPA 配信を所有し、`/api/*` も全てここで処理する。
 *
 * 起動トポロジ:
 *   bun server/index.ts            公開ポート（--port / PORT / 既定 8765）
 *     └─ vite dev                  内部ポート（開発時のみ・子プロセス）
 *
 * #75 で FastAPI（uvicorn）へのプロキシを撤去した。未知の `/api/*` は移行前の
 * FastAPI と同じ 404 に落ちる。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import { Hono } from "hono";
import { APPLY_BUSY_MESSAGE, releaseApply, tryAcquireApply } from "./applyLock";
import { ignoreFile, lockFile, projectDecksDir } from "./domain/config";
import {
  collectCustomUpdatable,
  installedCustomSkillLocation,
  updateCustomFromRepo,
} from "./domain/custom";
import {
  addSkillsToProjectDeck,
  createEmptyProjectDeck,
  deckPath,
  loadDeck,
  loadOptionalProjectDeck,
  saveProjectDeckSelection,
  UnknownDeckError,
  writeProjectDeckSkills,
} from "./domain/decks";
import { DraftConflictError, promoteDrafts } from "./domain/drafts";
import { AlreadyExistsError, ValueError } from "./domain/errors";
import {
  activeExternalSkillNames,
  addExternalToLock,
  collectExternalUpdateStatus,
  collectUpdatableSkillNames,
  externalRemoveCommand,
  externalSkillStillUpdatable,
  externalUpdateCommand,
  formatExternalUpdateMessage,
  isArgvSafeSkillName,
  registerInstalledExternalSelection,
  removeExternalSkillFromManagement,
  runExternalInstall,
} from "./domain/external";
import { commitRepoChanges } from "./infrastructure/git";
import {
  externalSkillCandidates,
  normalizeGithubSource,
} from "./infrastructure/github";
import {
  loadLock,
  saveLock,
  sortNames,
  trackedSkills,
} from "./domain/inventory";
import {
  deletePreset,
  hasPreviousPreset,
  previewNamedPreset,
  previewRestorePrevious,
  savePresetFromActive,
} from "./domain/presets";
import {
  applyDeck,
  applyProjectDeckSelection,
  applyNamedPreset,
  bulkOffActive,
  installCustomFromRepo,
  restorePreviousPreset,
} from "./domain/projection";
import {
  computeTristateApplyDelta,
  formatTristateApplySummary,
  parseTristateStates,
} from "./domain/tristate";
import { fetchOgp } from "./ogp";
import {
  draftsPayload,
  externalPreviewPayload,
  externalSourceDetailPayload,
  externalSourcesPayload,
  globalPayload,
  projectDeckPayload,
} from "./payloads";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const FRONTEND_DIR = join(REPO_ROOT, "app", "frontend");
const DIST_DIR = join(FRONTEND_DIR, "dist");
const PUBLIC_DIR = join(FRONTEND_DIR, "public");

/** プロキシ時に転送してはいけないヘッダ。fetch が本文を解凍済みなので長さ系も落とす。 */
const HOP_BY_HOP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** 壊れた JSON は空 body と同じ扱い。移行前の `read_json` と同じ。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

/** 例外を移行前の `str(exc)` に近い 1 行へ落とす。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 引数と環境変数 ----

type Args = { host: string; port: number | null; dev: boolean };

/** 移行前の argparse に対応する `skill-loom ui --help`。 */
const HELP_TEXT = `usage: skill-loom ui [-h] [--host HOST] [--port PORT] [--dev]

options:
  -h, --help   show this help message and exit
  --host HOST
  --port PORT  Listen port (default: PORT env or 8765; 0 = OS-assigned)
  --dev        Enable Vite dev server with hot reload (same as
               MY_SKILLS_VITE=1)
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { host: "127.0.0.1", port: null, dev: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    } else if (arg === "--host") args.host = argv[++i] ?? args.host;
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--dev") args.dev = true;
    else if (arg.startsWith("--host=")) args.host = arg.slice("--host=".length);
    else if (arg.startsWith("--port="))
      args.port = Number(arg.slice("--port=".length));
  }
  return args;
}

/** `resolve_ui_port` と同じ優先順位: --port → PORT → 8765。0 は OS 任せ。 */
function resolvePort(cliPort: number | null): number {
  if (cliPort !== null && Number.isFinite(cliPort)) return cliPort;
  const envPort = process.env.PORT;
  if (envPort) return Number(envPort);
  return 8765;
}

/** `vite_enabled` と同じ判定。明示フラグが最優先で、既定は dist の有無。 */
function viteEnabled(dev: boolean): boolean {
  const flag = (process.env.MY_SKILLS_VITE ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return false;
  if (flag === "1" || flag === "true" || flag === "yes" || dev) return true;
  return !existsSync(DIST_DIR);
}

// ---- ポート ----

function findFreePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function waitForPort(
  hostname: string,
  port: number,
  timeoutMs = 20_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const socket = await Bun.connect({
        hostname,
        port,
        socket: { data() {} },
      });
      socket.end();
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

// ---- 子プロセス ----

const children: Subprocess[] = [];

function startVite(port: number): Subprocess {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: FRONTEND_DIR, stdout: "ignore", stderr: "ignore" }
  );
  children.push(proc);
  return proc;
}

let shuttingDown = false;

function shutdown(code: number | null = null): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // 既に終了している子は無視する
    }
  }
  if (code !== null) process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(0));
}
process.on("exit", () => shutdown());

// ---- SPA 配信 ----

/**
 * `Response.json` は content-type に `;charset=utf-8` を付けてしまうので使わない。
 * 移行前の Starlette の JSONResponse と同じヘッダを再現する。
 */
function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

async function serveFromDist(pathname: string): Promise<Response> {
  const index = Bun.file(join(DIST_DIR, "index.html"));
  if (!(await index.exists())) {
    return jsonResponse(
      {
        message:
          "Frontend not built. Run: cd app/frontend && bun run build (or set MY_SKILLS_VITE=1 / use --dev)",
      },
      503
    );
  }
  if (pathname !== "/") {
    // dist 直下の実ファイル（/assets/* や vite.svg など）はそのまま返す
    const candidate = Bun.file(join(DIST_DIR, pathname.replace(/^\/+/, "")));
    if (await candidate.exists()) return new Response(candidate);
  }
  return new Response(index);
}

/** 移行前の Starlette が空レスポンスに付けていた content-type をそのまま再現する。 */
function emptyTextResponse(): Response {
  return new Response("", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function serveStaticPublicFile(
  name: string,
  contentType: string
): Promise<Response> {
  for (const base of [DIST_DIR, PUBLIC_DIR]) {
    const file = Bun.file(join(base, name));
    if (await file.exists())
      return new Response(file, { headers: { "content-type": contentType } });
  }
  return emptyTextResponse();
}

// ---- WebSocket プロキシ（Vite HMR）----

type WsFrame = string | ArrayBuffer;

type WsData = {
  target: string;
  protocol: string | null;
  upstream?: WebSocket;
  queue: WsFrame[];
};

/** Bun は binary フレームを Buffer で渡すので、send が受ける ArrayBuffer に正規化する。 */
function toFrame(message: string | Uint8Array): WsFrame {
  if (typeof message === "string") return message;
  return message.buffer.slice(
    message.byteOffset,
    message.byteOffset + message.byteLength
  ) as ArrayBuffer;
}

const wsHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    const { target, protocol } = ws.data;
    const upstream = protocol
      ? new WebSocket(target, protocol)
      : new WebSocket(target);
    upstream.binaryType = "arraybuffer";
    ws.data.upstream = upstream;

    upstream.onopen = () => {
      for (const queued of ws.data.queue) upstream.send(queued);
      ws.data.queue.length = 0;
    };
    upstream.onmessage = (event: MessageEvent) => ws.send(event.data);
    upstream.onclose = () => ws.close();
    upstream.onerror = () => ws.close();
  },
  message(ws: ServerWebSocket<WsData>, message: string | Uint8Array) {
    const frame = toFrame(message);
    const upstream = ws.data.upstream;
    if (upstream && upstream.readyState === WebSocket.OPEN)
      upstream.send(frame);
    else ws.data.queue.push(frame);
  },
  close(ws: ServerWebSocket<WsData>) {
    ws.data.upstream?.close();
  },
};

// ---- ルーティング ----

const args = parseArgs(Bun.argv.slice(2));
const publicPort = resolvePort(args.port);
const useVite = viteEnabled(args.dev);

if (!useVite && !existsSync(DIST_DIR)) {
  console.log("Building frontend (first run / tests)...");
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: FRONTEND_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!build.success) {
    console.error("Frontend build failed");
    process.exit(1);
  }
}

let vitePort: number | null = null;
if (useVite) {
  vitePort = findFreePort();
  startVite(vitePort);
  if (!(await waitForPort("127.0.0.1", vitePort))) {
    console.error(`Vite failed to start on port ${vitePort}`);
    shutdown(1);
  }
}

const app = new Hono();

// ---- 移植済みルート ----

/**
 * Inventory の読み取り。#67 で TypeScript 側へ移った最初のルート。
 */
app.get("/api/global", (c) => {
  const showCatalog = c.req.query("catalog") === "1";
  return jsonResponse(globalPayload(loadLock(), "", { showCatalog }), 200);
});

/** payload に message を載せたエラー応答。移行前の `json_err` と同じ形。 */
function errorResponse(
  message: string,
  status: number,
  payload: object
): Response {
  // message は payload 側にも既にあるので、上書きしてもキー順は動かない。
  return jsonResponse({ ...payload, message }, status);
}

/**
 * tristate の Apply。#68 で移植。projection の 4 か所書き込みはここから始まる。
 */
app.post("/api/apply", async (c) => {
  const states = parseTristateStates(await readJson(c.req.raw));
  const base = globalPayload(loadLock(), "");
  if (Object.keys(states).length === 0)
    return errorResponse("変更がありません", 400, base);

  const { extra, restore, install, remove, unresolved } =
    computeTristateApplyDelta(states, loadLock());
  // 解決できない skill が 1 つでもあれば、1 バイトも書かずに返す。
  if (unresolved.size > 0) {
    return errorResponse(
      `Unresolved: ${sortNames(unresolved).join(", ")}`,
      400,
      base
    );
  }
  if (!tryAcquireApply()) return errorResponse(APPLY_BUSY_MESSAGE, 409, base);

  let warning: string;
  try {
    const tracked = trackedSkills(loadLock());
    warning = applyDeck(
      extra,
      restore,
      new Set([...install].filter((n) => tracked.has(n))),
      loadLock(),
      remove
    );
  } catch (error) {
    return errorResponse(
      `Apply failed: ${errorText(error)}`,
      500,
      globalPayload(loadLock(), "")
    );
  } finally {
    releaseApply();
  }

  const summary = formatTristateApplySummary(extra, restore, install, remove);
  const message = warning ? `${summary} / ${warning}` : summary;
  return jsonResponse(globalPayload(loadLock(), message), 200);
});

/** 管理下の active を一括で Off にする。直前の状態は `_last` preset に退避される。 */
app.post("/api/bulk-off", () => {
  const base = globalPayload(loadLock(), "");
  if (!tryAcquireApply()) return errorResponse(APPLY_BUSY_MESSAGE, 409, base);

  let removed: Set<string>;
  try {
    removed = bulkOffActive(loadLock(), true);
  } catch (error) {
    if (error instanceof ValueError)
      return errorResponse(error.message, 400, base);
    return errorResponse(
      `Bulk off failed: ${errorText(error)}`,
      500,
      globalPayload(loadLock(), "")
    );
  } finally {
    releaseApply();
  }

  const message = `すべてオフにしました (${removed.size}): ${sortNames(removed).join(", ")}`;
  return jsonResponse(globalPayload(loadLock(), message), 200);
});

// ---- preset（#69 で移植）----

/** body から文字列フィールドを取り出す。移行前の `str(body.get(...)).strip()` と同じ。 */
function bodyString(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null)?.[key];
  return String(value ?? "").trim();
}

function bodyFlag(body: unknown, key: string): boolean {
  return Boolean((body as Record<string, unknown> | null)?.[key]);
}

/** preset の当たり先を先に見せる。ここは読み取りだけで、何も動かさない。 */
app.get("/api/presets/:name/preview", (c) => {
  const base = globalPayload(loadLock(), "");
  try {
    return jsonResponse(
      {
        ...base,
        presetPreview: previewNamedPreset(c.req.param("name"), loadLock()),
      },
      200
    );
  } catch (error) {
    return errorResponse(errorText(error), 400, base);
  }
});

app.post("/api/presets/save", async (c) => {
  const body = await readJson(c.req.raw);
  const name = bodyString(body, "name");
  const base = globalPayload(loadLock(), "");
  if (!name) return errorResponse("Preset name is required", 400, base);

  let saved: ReturnType<typeof savePresetFromActive>;
  try {
    saved = savePresetFromActive(
      name,
      loadLock(),
      bodyString(body, "description"),
      bodyFlag(body, "overwrite")
    );
  } catch (error) {
    // 既存 preset の上書き拒否だけは 409。フロントはこれを見て overwrite を出す。
    if (error instanceof AlreadyExistsError)
      return errorResponse(error.message, 409, base);
    return errorResponse(errorText(error), 400, base);
  }
  return jsonResponse(
    globalPayload(
      loadLock(),
      `Saved preset: ${saved.name} (${saved.skills.length} skills)`
    ),
    200
  );
});

/**
 * preset の適用。confirm が無い間は preview を返すだけで、projection は動かさない。
 */
app.post("/api/presets/apply", async (c) => {
  const body = await readJson(c.req.raw);
  const name = bodyString(body, "name");
  const base = globalPayload(loadLock(), "");
  if (!name) return errorResponse("Preset name is required", 400, base);

  let preview: ReturnType<typeof previewNamedPreset>;
  try {
    preview = previewNamedPreset(name, loadLock());
  } catch (error) {
    return errorResponse(errorText(error), 400, base);
  }
  if (preview.blocked) {
    const message = `Unresolved: ${preview.preview.unresolved.join(", ")}`;
    return errorResponse(message, 400, { ...base, presetPreview: preview });
  }
  if (!bodyFlag(body, "confirm")) {
    return jsonResponse(
      { ...base, presetPreview: preview, message: "確認してください" },
      200
    );
  }
  if (!tryAcquireApply()) return errorResponse(APPLY_BUSY_MESSAGE, 409, base);

  try {
    applyNamedPreset(name, loadLock(), true);
  } catch (error) {
    return errorResponse(
      `Apply failed: ${errorText(error)}`,
      500,
      globalPayload(loadLock(), "")
    );
  } finally {
    releaseApply();
  }
  return jsonResponse(
    globalPayload(loadLock(), `Applied preset: ${name}`),
    200
  );
});

/** 直前の active に戻す。解決できない skill はスキップして進む（止めると戻れなくなる）。 */
app.post("/api/presets/restore", async (c) => {
  const body = await readJson(c.req.raw);
  const base = globalPayload(loadLock(), "");
  if (!hasPreviousPreset())
    return errorResponse("No previous state saved", 400, base);

  let preview: ReturnType<typeof previewRestorePrevious>;
  try {
    preview = previewRestorePrevious(loadLock());
  } catch (error) {
    return errorResponse(errorText(error), 400, base);
  }
  if (!bodyFlag(body, "confirm")) {
    const skipped = preview.preview.unresolved;
    const message =
      skipped.length > 0
        ? `確認してください（復元スキップ ${skipped.length}: ${skipped.join(", ")}）`
        : "確認してください";
    return jsonResponse({ ...base, presetPreview: preview, message }, 200);
  }
  if (!tryAcquireApply()) return errorResponse(APPLY_BUSY_MESSAGE, 409, base);

  let plan: ReturnType<typeof restorePreviousPreset>;
  try {
    plan = restorePreviousPreset(loadLock());
  } catch (error) {
    return errorResponse(
      `Restore failed: ${errorText(error)}`,
      500,
      globalPayload(loadLock(), "")
    );
  } finally {
    releaseApply();
  }

  const skipped = sortNames(plan.unresolved);
  let message = "Restored previous active set";
  if (skipped.length > 0)
    message += `（スキップ ${skipped.length}: ${skipped.join(", ")}）`;
  return jsonResponse(globalPayload(loadLock(), message), 200);
});

app.post("/api/presets/delete", async (c) => {
  const name = bodyString(await readJson(c.req.raw), "name");
  const base = globalPayload(loadLock(), "");
  if (!name) return errorResponse("Preset name is required", 400, base);

  try {
    deletePreset(name);
  } catch (error) {
    return errorResponse(errorText(error), 400, base);
  }
  return jsonResponse(
    globalPayload(loadLock(), `Deleted preset: ${name}`),
    200
  );
});

// Apply とはロックを共有するが、文言は移行前のまま操作ごとに分けている。
// update の文言は custom と外部 source で同じなので 1 つで足りる。
const UPDATE_BUSY_MESSAGE =
  "Update already running. Wait for the current update to finish.";
const REMOVE_BUSY_MESSAGE =
  "Remove already running. Wait for the current remove to finish.";

// ---- custom skill の更新（#71 で移植）----

/** 確認結果を載せた payload。checked を立てないと UI が「未確認」のままになる。 */
function checkedPayload(message: string): Response {
  const lock = loadLock();
  return jsonResponse(
    globalPayload(lock, message, {
      customUpdatesChecked: true,
      customUpdatable: collectCustomUpdatable(lock),
    }),
    200
  );
}

app.post("/api/custom/check-updates", () => {
  const updatable = collectCustomUpdatable(loadLock());
  const message =
    updatable.length > 0
      ? `更新確認完了: 更新あり ${updatable.length} skills`
      : "更新確認完了: すべて最新です";
  return checkedPayload(message);
});

app.post("/api/custom/update", async (c) => {
  const skill = bodyString(await readJson(c.req.raw), "skill");
  const base = globalPayload(loadLock(), "");
  if (!skill)
    return errorResponse("updateするskillを選択してください", 400, base);
  if (!(skill in (loadLock().custom?.skills ?? {}))) {
    return errorResponse(`custom skill ではありません: ${skill}`, 400, base);
  }
  // active にも archive にも無ければ、上書きする相手がいない。
  if (installedCustomSkillLocation(skill)[0] === null) {
    return errorResponse(
      `展開されていないため update できません: ${skill}`,
      400,
      base
    );
  }
  if (!tryAcquireApply()) return errorResponse(UPDATE_BUSY_MESSAGE, 409, base);

  try {
    updateCustomFromRepo(new Set([skill]), loadLock());
  } catch (error) {
    return errorResponse(
      `updateに失敗: ${errorText(error)}`,
      500,
      globalPayload(loadLock(), "")
    );
  } finally {
    releaseApply();
  }
  return checkedPayload(`updated: ${skill}`);
});

app.post("/api/custom/update-all", async (c) => {
  const body = await readJson(c.req.raw);
  const requested = (body as Record<string, unknown> | null)?.skills;
  // 指定が無ければ drift しているものを全部。指定があればそれだけ。
  const names =
    Array.isArray(requested) && requested.length > 0
      ? new Set(requested.map((name) => String(name).trim()).filter(Boolean))
      : new Set(collectCustomUpdatable(loadLock()).map((row) => row.name));

  const base = globalPayload(loadLock(), "");
  if (names.size === 0)
    return errorResponse("更新対象のskillはありません", 400, base);
  const custom = loadLock().custom?.skills ?? {};
  const unknown = sortNames([...names].filter((name) => !(name in custom)));
  if (unknown.length > 0)
    return errorResponse(
      `custom skill ではありません: ${unknown.join(", ")}`,
      400,
      base
    );
  if (!tryAcquireApply()) return errorResponse(UPDATE_BUSY_MESSAGE, 409, base);

  let updated: string[];
  try {
    updated = updateCustomFromRepo(names, loadLock());
  } catch (error) {
    return errorResponse(
      `updateに失敗: ${errorText(error)}`,
      500,
      globalPayload(loadLock(), "")
    );
  } finally {
    releaseApply();
  }
  return checkedPayload(`updated: ${updated.join(", ")}`);
});

// ---- 外部 source（#70 で移植）----

/** 移行前の `subprocess.run(..., check=True)` と同じく、非 0 終了を例外にする。 */
function runExternalCommand(command: string[]): void {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command '${command.join(" ")}' returned non-zero exit status ${result.exitCode}.`
    );
  }
}

app.get("/api/external-sources", () =>
  jsonResponse(externalSourcesPayload(loadLock()), 200)
);

/**
 * source 一覧のカードに出す OGP。ここだけ payload を返さず message だけで失敗する
 * （表示の飾りなので、失敗しても画面を組み直す必要が無い）。
 */
app.get("/api/ogp/:source{.+}", async (c) => {
  let ownerRepo: string;
  try {
    ownerRepo = normalizeGithubSource(
      c.req.param("source").replace(/^\/+|\/+$/g, "")
    );
  } catch (error) {
    return jsonResponse({ message: errorText(error) }, 400);
  }
  try {
    return jsonResponse(
      { ...(await fetchOgp(ownerRepo)), source: ownerRepo },
      200
    );
  } catch (error) {
    return jsonResponse({ message: `OGP取得に失敗: ${errorText(error)}` }, 502);
  }
});

/** POST 側を先に置く。GET のワイルドカードと衝突しないよう、メソッドで分かれている。 */
app.post("/api/external-sources/check-updates", async (c) => {
  const source = bodyString(await readJson(c.req.raw), "source");
  return await sourceDetailResponse(source, 200);
});

app.post("/api/external-sources/check-all-updates", async () => {
  const [statusBySource, errors] =
    await collectExternalUpdateStatus(loadLock());
  const total = Object.values(statusBySource).reduce(
    (sum, status) =>
      sum + (status.checked ? (status.updatable?.length ?? 0) : 0),
    0
  );
  let message: string;
  if (errors.length > 0)
    message = `一部のsource確認に失敗 (${errors.length}): ${errors.slice(0, 3).join("; ")}`;
  else if (total) message = `更新確認完了: 更新あり ${total} skills`;
  else message = "更新確認完了: すべて最新です";
  return jsonResponse(
    externalSourcesPayload(loadLock(), message, statusBySource),
    200
  );
});

app.post("/api/external-sources/update", async (c) => {
  const skill = bodyString(await readJson(c.req.raw), "skill");
  const base = externalSourcesPayload(loadLock());
  if (!skill)
    return errorResponse("updateするskillを選択してください", 400, base);
  // active でない skill を update しても projection には出ない。押させない。
  if (!activeExternalSkillNames(loadLock()).has(skill)) {
    return errorResponse(
      `active ではないため update できません: ${skill}`,
      400,
      base
    );
  }
  if (!tryAcquireApply()) return errorResponse(UPDATE_BUSY_MESSAGE, 409, base);

  try {
    runExternalCommand(externalUpdateCommand(skill));
  } catch (error) {
    return errorResponse(
      `updateに失敗: ${errorText(error)}`,
      500,
      externalSourcesPayload(loadLock())
    );
  } finally {
    releaseApply();
  }

  // CLI が黙って何もしないことがあるので、走らせた後にもう一度確かめる。
  const message = (await externalSkillStillUpdatable(loadLock(), skill))
    ? formatExternalUpdateMessage([], [skill], [])
    : formatExternalUpdateMessage([skill], [], []);
  const [statusBySource] = await collectExternalUpdateStatus(loadLock());
  return jsonResponse(
    externalSourcesPayload(loadLock(), message, statusBySource),
    200
  );
});

app.post("/api/external-sources/update-all", async (c) => {
  const sourceFilter = bodyString(await readJson(c.req.raw), "source") || null;
  const [updatable, fetchErrors] = await collectUpdatableSkillNames(
    loadLock(),
    sourceFilter
  );
  if (updatable.length === 0) {
    const message = `更新対象のskillはありません${fetchErrors.length > 0 ? `: ${fetchErrors.slice(0, 3).join("; ")}` : ""}`;
    return await updateAllErrorResponse(sourceFilter, message, 400);
  }
  if (!tryAcquireApply())
    return await updateAllErrorResponse(sourceFilter, UPDATE_BUSY_MESSAGE, 409);

  const updated: string[] = [];
  const unchanged: string[] = [];
  const failed: string[] = [];
  try {
    for (const skill of updatable) {
      try {
        runExternalCommand(externalUpdateCommand(skill));
        if (await externalSkillStillUpdatable(loadLock(), skill))
          unchanged.push(skill);
        else updated.push(skill);
      } catch {
        failed.push(skill);
      }
    }
  } finally {
    releaseApply();
  }

  const message = formatExternalUpdateMessage(
    updated,
    unchanged,
    failed,
    fetchErrors
  );
  const status = failed.length > 0 ? 500 : 200;
  if (sourceFilter) {
    try {
      const candidates = externalSkillCandidates(sourceFilter);
      return jsonResponse(
        await externalSourceDetailPayload(
          loadLock(),
          sourceFilter,
          candidates,
          message
        ),
        status
      );
    } catch (error) {
      return errorResponse(
        `${message} / 再確認失敗: ${errorText(error)}`,
        500,
        externalSourcesPayload(loadLock())
      );
    }
  }
  const [statusBySource] = await collectExternalUpdateStatus(loadLock());
  return jsonResponse(
    externalSourcesPayload(loadLock(), message, statusBySource),
    status
  );
});

/**
 * 管理から外す。CLI で消し、lock と project deck からも落とし、その差分を commit する。
 * commit まで済ませないと、次の pull で lock が戻って skill が復活する。
 */
app.post("/api/external-sources/remove", async (c) => {
  const skill = bodyString(await readJson(c.req.raw), "skill");
  const base = externalSourcesPayload(loadLock());
  if (!skill)
    return errorResponse("管理から外すskillを選択してください", 400, base);
  if (!isArgvSafeSkillName(skill))
    return errorResponse(`skill名として扱えません: ${skill}`, 400, base);
  if (!tryAcquireApply()) return errorResponse(REMOVE_BUSY_MESSAGE, 409, base);

  let removedDecks = 0;
  let commitNote = "";
  try {
    runExternalCommand(externalRemoveCommand(skill));
    const currentLock = loadLock();
    removedDecks = removeExternalSkillFromManagement(currentLock, skill);
    saveLock(currentLock);
    commitNote = commitRepoChanges(
      `chore: remove ${skill} from skills.lock.json`,
      [lockFile(), projectDecksDir()]
    );
  } catch (error) {
    return errorResponse(
      `removeに失敗: ${errorText(error)}`,
      500,
      externalSourcesPayload(loadLock())
    );
  } finally {
    releaseApply();
  }
  const message = `removed: ${skill} (project decks ${removedDecks})${commitNote}`;
  return jsonResponse(externalSourcesPayload(loadLock(), message), 200);
});

/** GET の source 詳細。POST の check-updates と同じ本体なので、下のヘルパに寄せてある。 */
app.get("/api/external-sources/:source{.+}", async (c) => {
  return await sourceDetailResponse(
    c.req.param("source").replace(/^\/+|\/+$/g, ""),
    200
  );
});

/** 候補取得に失敗したときは source 一覧の payload へ落として、画面を描けるようにする。 */
async function sourceDetailResponse(
  source: string,
  status: number
): Promise<Response> {
  let candidates: ReturnType<typeof externalSkillCandidates>;
  try {
    candidates = externalSkillCandidates(source);
  } catch (error) {
    return errorResponse(
      `候補取得に失敗: ${errorText(error)}`,
      400,
      externalSourcesPayload(loadLock())
    );
  }
  return jsonResponse(
    await externalSourceDetailPayload(loadLock(), source, candidates),
    status
  );
}

/** update-all の失敗応答。source 指定があれば、その source の詳細を添えて返す。 */
async function updateAllErrorResponse(
  sourceFilter: string | null,
  message: string,
  status: number
): Promise<Response> {
  if (!sourceFilter)
    return errorResponse(message, status, externalSourcesPayload(loadLock()));
  let candidates: ReturnType<typeof externalSkillCandidates>;
  try {
    candidates = externalSkillCandidates(sourceFilter);
  } catch (error) {
    return errorResponse(
      `候補取得に失敗: ${errorText(error)}`,
      status,
      externalSourcesPayload(loadLock())
    );
  }
  const detail = await externalSourceDetailPayload(
    loadLock(),
    sourceFilter,
    candidates
  );
  return errorResponse(message, status, detail);
}

// ---- draft（#72 で移植）----

const DRAFT_ACTIONS: ReadonlySet<string> = new Set([
  "promote",
  "install",
  "promote-force",
  "install-force",
]);
const DRAFT_BUSY_MESSAGE =
  "Draft operation already running. Wait for the current operation to finish.";

app.get("/api/drafts", () => jsonResponse(draftsPayload(loadLock()), 200));

/**
 * draft を正式配置へ昇格させる。action に `-force` が付くと、既に正式登録済み /
 * 配置先が埋まっている場合でも上書きする。`install` 系はそのまま global にも展開する。
 */
app.post("/api/drafts/:action", async (c) => {
  const action = c.req.param("action");
  // 移行前は未知の action にルーティング自体が当たらず 404 だった。
  if (!DRAFT_ACTIONS.has(action))
    return jsonResponse({ message: "Not found" }, 404);

  const body = await readJson(c.req.raw);
  const requested = (body as Record<string, unknown> | null)?.skills;
  const selected = new Set(
    Array.isArray(requested) ? requested.map((name) => String(name)) : []
  );
  const install = action === "install" || action === "install-force";
  const force = action === "promote-force" || action === "install-force";

  if (!tryAcquireApply())
    return errorResponse(DRAFT_BUSY_MESSAGE, 409, draftsPayload(loadLock()));
  try {
    const [promoted, newLock, commitPaths] = promoteDrafts(selected, force);
    // lock は昇格後の内容を書き戻し済み。commit 対象パスは promoteDrafts が返す。
    const paths = [lockFile(), ...commitPaths];
    const commitNote = commitRepoChanges(
      `feat: add ${promoted.join(", ")}`,
      paths
    );
    if (install) installCustomFromRepo(new Set(promoted), newLock);
    const label = install ? "draft解除してglobalに追加" : "draft解除";
    return jsonResponse(
      draftsPayload(
        loadLock(),
        `${label}: ${promoted.join(", ")}${commitNote}`
      ),
      200
    );
  } catch (error) {
    if (error instanceof DraftConflictError) {
      return errorResponse(
        `確認が必要です: ${error.names.join(", ")} は既に正式登録済み、または正式配置先が存在します。`,
        409,
        draftsPayload(loadLock(), "", error.names)
      );
    }
    return errorResponse(
      `Draft operation failed: ${errorText(error)}`,
      400,
      draftsPayload(loadLock())
    );
  } finally {
    releaseApply();
  }
});

// ---- project deck（#73 で移植）----

const DECK_ACTIONS: ReadonlySet<string> = new Set(["apply", "merge", "save"]);

/** deck が無いときは deck ページを描けないので、global の payload を添えて 404 にする。 */
function unknownDeckResponse(error: unknown): Response {
  return errorResponse(errorText(error), 404, globalPayload(loadLock(), ""));
}

/**
 * 空の Project Deck を生やす。既存の上書きはしない（409）。
 *
 * 作ったあとは deck ページへ遷移できるよう、その deck の payload を返す。
 */
app.post("/api/project-decks", async (c) => {
  const body = await readJson(c.req.raw);
  const name = bodyString(body, "name");
  const description = bodyString(body, "description");
  const base = globalPayload(loadLock(), "");
  if (!name) return errorResponse("Project deck name is required", 400, base);

  let path: string;
  try {
    path = createEmptyProjectDeck(name, description);
  } catch (error) {
    if (error instanceof AlreadyExistsError)
      return errorResponse(error.message, 409, base);
    return errorResponse(errorText(error), 400, base);
  }
  const commitNote = commitRepoChanges(`chore: create project deck ${name}`, [
    path,
  ]);
  return jsonResponse(
    projectDeckPayload(loadLock(), name, `Created deck: ${name}${commitNote}`),
    200
  );
});

app.get("/api/project-decks/:deckName", (c) => {
  const deckName = c.req.param("deckName");
  const showCatalog = c.req.query("catalog") === "1";
  try {
    return jsonResponse(
      projectDeckPayload(loadLock(), deckName, "", { showCatalog }),
      200
    );
  } catch (error) {
    if (error instanceof UnknownDeckError) return unknownDeckResponse(error);
    throw error;
  }
});

/**
 * deck の保存と Apply。
 *
 * ADR 0005: `apply` は Core Deck を必ず union する（deck を選んだだけで日常作業用の
 * 共通 skill が外れないようにするため）。`merge` は今の active に足すだけで、
 * Core Deck は足さない — 足すと「今の状態に上乗せする」という意味が壊れる。
 */
app.post("/api/project-decks/:deckName/:action", async (c) => {
  const deckName = c.req.param("deckName");
  const action = c.req.param("action");
  // 移行前は未知の action にルーティング自体が当たらず 404 だった。
  if (!DECK_ACTIONS.has(action))
    return jsonResponse({ message: "Not found" }, 404);

  const body = await readJson(c.req.raw);
  const requested = (body as Record<string, unknown> | null)?.skills;
  const selected = new Set(
    Array.isArray(requested) ? requested.map((name) => String(name)) : []
  );

  if (action === "save") {
    let savedCount: number;
    try {
      savedCount = saveProjectDeckSelection(deckName, selected);
    } catch (error) {
      return errorResponse(
        `Save failed: ${errorText(error)}`,
        500,
        projectDeckPayload(loadLock(), deckName)
      );
    }
    return jsonResponse(
      projectDeckPayload(
        loadLock(),
        deckName,
        `Saved deck: ${savedCount} direct skills`
      ),
      200
    );
  }

  try {
    loadDeck(deckName, new Set(), true);
  } catch (error) {
    if (error instanceof UnknownDeckError) return unknownDeckResponse(error);
    throw error;
  }

  const lock = loadLock();
  const base = projectDeckPayload(lock, deckName);
  if (!tryAcquireApply()) return errorResponse(APPLY_BUSY_MESSAGE, 409, base);

  let result: ReturnType<typeof applyProjectDeckSelection>;
  try {
    result = applyProjectDeckSelection(
      deckName,
      selected,
      action === "merge" ? "merge" : "apply",
      lock
    );
  } catch (error) {
    return errorResponse(
      `Apply failed: ${errorText(error)}`,
      500,
      projectDeckPayload(loadLock(), deckName)
    );
  } finally {
    releaseApply();
  }
  const unresolved = sortNames(result.unresolved);
  if (unresolved.length > 0)
    return errorResponse(`Unresolved: ${unresolved.join(", ")}`, 400, base);
  return jsonResponse(
    projectDeckPayload(
      loadLock(),
      deckName,
      `Applied: active target ${result.target.size}`
    ),
    200
  );
});

// ---- 外部 skill の取り込み（#74 で移植）----

const IMPORT_BUSY_MESSAGE =
  "Import already running. Wait for the current import to finish.";

/**
 * 取り込み画面の下地。deck 経由なら deck の catalog、global 直なら global の catalog。
 * 取り込みは deck ページからも global ページからも始まるので、失敗時に戻す先が 2 つある。
 */
function catalogPayload(deckName: string, message = ""): object {
  const lock = loadLock();
  return deckName
    ? projectDeckPayload(lock, deckName, message, { showCatalog: true })
    : globalPayload(lock, message, { showCatalog: true });
}

/** source から取り込める skill の一覧を出すだけ。ここでは何も入れない。 */
app.post("/api/external/preview", async (c) => {
  const body = await readJson(c.req.raw);
  const deckName = bodyString(body, "deck");
  const source = bodyString(body, "source");

  let candidates: ReturnType<typeof externalSkillCandidates>;
  try {
    loadOptionalProjectDeck(deckName);
    candidates = externalSkillCandidates(source);
  } catch (error) {
    return errorResponse(
      `候補取得に失敗: ${errorText(error)}`,
      400,
      catalogPayload(deckName)
    );
  }
  if (candidates.length === 0) {
    return errorResponse(
      "SKILL.md が見つかりませんでした",
      404,
      catalogPayload(deckName)
    );
  }
  return jsonResponse(
    externalPreviewPayload(loadLock(), deckName, source, candidates),
    200
  );
});

/**
 * 「installして追加」。実際に global へ入れたうえで lock に載せ、deck 指定があれば deck にも足す。
 * deck にだけ足す `/add-to-deck` とはここが違う（あちらは install しない）。
 */
app.post("/api/external/install", async (c) => {
  const body = await readJson(c.req.raw);
  const deckName = bodyString(body, "deck");
  const source = bodyString(body, "source");
  const requested = (body as Record<string, unknown> | null)?.skills;
  const selected = new Set(
    Array.isArray(requested) ? requested.map((name) => String(name)) : []
  );

  let ownerRepo: string;
  let deck: ReturnType<typeof loadOptionalProjectDeck>[0];
  let currentSkills: string[];
  try {
    ownerRepo = normalizeGithubSource(source);
    [deck, currentSkills] = loadOptionalProjectDeck(deckName);
  } catch (error) {
    return errorResponse(errorText(error), 400, globalPayload(loadLock(), ""));
  }
  if (selected.size === 0) {
    return errorResponse(
      "取り込むskillを選択してください",
      400,
      catalogPayload(deckName)
    );
  }
  if (!tryAcquireApply())
    return errorResponse(IMPORT_BUSY_MESSAGE, 409, catalogPayload(deckName));
  try {
    await runExternalInstall(ownerRepo, selected);
  } catch (error) {
    return errorResponse(
      `取り込みに失敗: ${errorText(error)}`,
      500,
      catalogPayload(deckName)
    );
  } finally {
    releaseApply();
  }

  const names = sortNames(selected).join(", ");
  const [, unignoredCount] = registerInstalledExternalSelection(
    ownerRepo,
    selected
  );
  const unignoredMessage = unignoredCount
    ? ` / ignored解除 ${unignoredCount}`
    : "";
  const commitNote = commitRepoChanges(
    `chore: add ${names} to skills.lock.json`,
    [lockFile(), ignoreFile()]
  );

  if (!deckName) {
    return jsonResponse(
      globalPayload(
        loadLock(),
        `外部skillsをglobalに追加しました: ${names}${unignoredMessage}${commitNote}`,
        {
          showCatalog: true,
        }
      ),
      200
    );
  }
  const path = writeProjectDeckSkills(
    deckName,
    deck,
    new Set([...currentSkills, ...selected])
  );
  const deckCommitNote = commitRepoChanges(
    `chore: add ${names} to project deck ${deckName}`,
    [path]
  );
  return jsonResponse(
    projectDeckPayload(
      loadLock(),
      deckName,
      `外部skillsを取り込みました: ${names}${unignoredMessage}${commitNote}${deckCommitNote}`,
      { showCatalog: true }
    ),
    200
  );
});

/**
 * 「deckにだけ追加」。global には入れず、lock と deck の定義だけを更新する。
 * deck を後から install したときに入る状態にしておくのが目的。
 */
app.post("/api/external/add-to-deck", async (c) => {
  const body = await readJson(c.req.raw);
  const deckName = bodyString(body, "deck");
  const source = bodyString(body, "source");
  const requested = (body as Record<string, unknown> | null)?.skills;
  const selected = new Set(
    Array.isArray(requested) ? requested.map((name) => String(name)) : []
  );

  let ownerRepo: string;
  try {
    loadDeck(deckName, new Set(), true);
    ownerRepo = normalizeGithubSource(source);
  } catch (error) {
    return errorResponse(errorText(error), 400, globalPayload(loadLock(), ""));
  }
  if (selected.size === 0) {
    return errorResponse(
      "deckに追加するskillを選択してください",
      400,
      catalogPayload(deckName)
    );
  }
  if (!tryAcquireApply())
    return errorResponse(IMPORT_BUSY_MESSAGE, 409, catalogPayload(deckName));

  let savedCount: number;
  try {
    addExternalToLock(ownerRepo, selected, externalSkillCandidates(ownerRepo));
    savedCount = addSkillsToProjectDeck(deckName, selected);
  } catch (error) {
    return errorResponse(
      `deck追加に失敗: ${errorText(error)}`,
      500,
      catalogPayload(deckName)
    );
  } finally {
    releaseApply();
  }

  const names = sortNames(selected).join(", ");
  const commitNote = commitRepoChanges(
    `chore: add ${names} to skills.lock.json and deck ${deckName}`,
    [lockFile(), deckPath(deckName, true)]
  );
  return jsonResponse(
    projectDeckPayload(
      loadLock(),
      deckName,
      `deckに追加しました: ${names} (${savedCount} skills)${commitNote}`,
      {
        showCatalog: true,
      }
    ),
    200
  );
});

/**
 * 未知の `/api/*`。#74 で全ルートが上の Hono ハンドラへ移ったので、ここへ落ちてくるのは
 * 知らないパスだけ。移行前の FastAPI（既定の Starlette 404）と同じ JSON で 404 にする。
 * SPA フォールバックより前に置かないと index.html が返ってしまう。
 */
app.all("/api/*", (c) => {
  const incoming = new URL(c.req.url);
  // Hono の `/api/*` は `/api` 自身にも当たるが、移行前は `/api` は SPA だった
  if (!incoming.pathname.startsWith("/api/"))
    return new Response(null, { status: 404 });
  return jsonResponse({ detail: "Not Found" }, 404);
});

app.get("/favicon.ico", () =>
  serveStaticPublicFile("favicon.ico", "image/x-icon")
);
app.get("/favicon.svg", () =>
  serveStaticPublicFile("favicon.svg", "image/svg+xml")
);
app.get("/apple-touch-icon.png", () =>
  serveStaticPublicFile("apple-touch-icon.png", "image/png")
);
app.get("/site.webmanifest", () =>
  serveStaticPublicFile("site.webmanifest", "application/manifest+json")
);
app.get("/.well-known/*", () => emptyTextResponse());

/**
 * SPA: 開発時は Vite へプロキシ、そうでなければビルド済み dist を配信する。
 * 移行前の spa_fallback と同じく GET / HEAD だけを受ける。
 */
app.on(["GET", "HEAD"], "*", async (c) => {
  const incoming = new URL(c.req.url);
  if (vitePort === null) return serveFromDist(incoming.pathname);

  const target = `http://127.0.0.1:${vitePort}${incoming.pathname}${incoming.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("accept-encoding");

  const upstream = await fetch(target, {
    method: c.req.method,
    headers,
    redirect: "manual",
  });
  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
});

/** GET / HEAD 以外で SPA パスに来たものは、移行前の FastAPI と同じ 405 を返す。 */
app.all("*", () =>
  jsonResponse({ detail: "Method Not Allowed" }, 405, { allow: "HEAD, GET" })
);

const server = Bun.serve({
  hostname: args.host,
  port: publicPort,
  idleTimeout: 0,
  fetch(req, srv) {
    // Vite HMR の WebSocket は公開ポートで受けて Vite へ中継する（同一オリジンを保つ）
    if (
      vitePort !== null &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const incoming = new URL(req.url);
      const protocol = req.headers.get("sec-websocket-protocol");
      const data: WsData = {
        target: `ws://127.0.0.1:${vitePort}${incoming.pathname}${incoming.search}`,
        protocol,
        queue: [],
      };
      if (srv.upgrade(req, { data })) return undefined;
    }
    return app.fetch(req);
  },
  websocket: wsHandlers,
});

if (vitePort !== null)
  console.log(
    `Vite dev server on 127.0.0.1:${vitePort} (proxied; do not open directly)`
  );
console.log(`Skill Loom UI on http://${args.host}:${server.port}`);
