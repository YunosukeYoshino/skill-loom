import { Hono, type Context } from "hono";
import { existsSync } from "node:fs";
import { bodyLimit } from "hono/body-limit";
import { join } from "node:path";
import type {
  SkillRef,
  SkillVersion,
  SkillView,
} from "../shared/skill-workspace-types";
import { ValueError } from "./domain/errors";
import { applySkillWorkspace } from "./domain/skill-apply";
import {
  checkSkillUpdates,
  discardSkillWorkspace,
  forkSkill,
  mergeSkillUpdates,
  reconcileSkillSource,
  renderSkillMarkdown,
  requireWorkspace,
  resolveSkillConflict,
  saveSkillFile,
  SkillWorkspaceConflict,
  viewSkill,
  workspaceRoot,
} from "./domain/skill-workspace";
import {
  getSkillCodexSession,
  isSkillCodexBusy,
  shutdownSkillCodexSession,
} from "./infrastructure/skill-codex";
import { checkedSkillRef as reference } from "./domain/skill-reference";
import { localRequestGuard } from "./requestGuard";

const changing = new Set<string>();

async function requestBody(request: Request): Promise<Record<string, any>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new ValueError("A JSON object is required");
  }
}

function queryReference(request: Request): SkillRef {
  const query = new URL(request.url).searchParams;
  return reference({
    name: query.get("name") ?? "",
    source: query.get("source") ?? undefined,
    skillPath: query.get("skillPath") ?? undefined,
  });
}

function reviewedChange(
  action: (ref: SkillRef, revision: string) => Promise<SkillView>
) {
  return async (c: Context) => {
    const body = await requestBody(c.req.raw);
    const ref = reference(body.ref);
    if (typeof body.revision !== "string")
      throw new ValueError("Reviewed revision is required");
    return c.json(await change(ref, () => action(ref, body.revision)));
  };
}

function codex(ref: SkillRef) {
  requireWorkspace(ref);
  const root = workspaceRoot(ref.name);
  return getSkillCodexSession(
    join(root, "files"),
    join(root, "conversation.json")
  );
}

async function change<T>(ref: SkillRef, action: () => Promise<T>): Promise<T> {
  if (changing.has(ref.name))
    throw new SkillWorkspaceConflict("This working copy is busy");
  // No process is started by this check.
  const root = join(workspaceRoot(ref.name), "files");
  if (existsSync(root) && isSkillCodexBusy(root))
    throw new SkillWorkspaceConflict(
      "Stop Codex before changing this working copy"
    );
  changing.add(ref.name);
  try {
    return await action();
  } finally {
    changing.delete(ref.name);
  }
}

export function createSkillRoutes(): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("*", localRequestGuard);
  app.onError((error, c) =>
    c.json(
      { message: error.message },
      error instanceof SkillWorkspaceConflict
        ? 409
        : error instanceof ValueError
          ? 400
          : 500
    )
  );
  app.get("/", async (c) => {
    const ref = queryReference(c.req.raw);
    return c.json(
      await viewSkill(
        ref,
        (c.req.query("version") ?? "source") as SkillVersion,
        c.req.query("file") ?? "SKILL.md"
      )
    );
  });
  app.post("/fork", async (c) => {
    const body = await requestBody(c.req.raw);
    const ref = reference(body.ref);
    return c.json(await change(ref, () => forkSkill(ref)));
  });
  app.post("/save", async (c) => {
    const body = await requestBody(c.req.raw);
    const ref = reference(body.ref);
    if (typeof body.path !== "string")
      throw new ValueError("Skill path is required");
    return c.json(
      await change(ref, () =>
        saveSkillFile(ref, body.path, body.content, body.revision)
      )
    );
  });
  app.post("/preview", async (c) => {
    const body = await requestBody(c.req.raw);
    return c.json({ html: renderSkillMarkdown(body.content) });
  });
  app.post("/validate", async (c) => {
    const body = await requestBody(c.req.raw);
    return c.json(await viewSkill(reference(body.ref), "work"));
  });
  app.post("/apply", reviewedChange(applySkillWorkspace));
  app.post("/discard", async (c) => {
    const ref = reference((await requestBody(c.req.raw)).ref);
    return c.json(
      await change(ref, async () => {
        requireWorkspace(ref);
        await shutdownSkillCodexSession(join(workspaceRoot(ref.name), "files"));
        return discardSkillWorkspace(ref);
      })
    );
  });
  app.post("/check-upstream", async (c) => {
    const ref = reference((await requestBody(c.req.raw)).ref);
    return c.json(await change(ref, () => checkSkillUpdates(ref)));
  });
  app.post("/merge-upstream", async (c) => {
    const ref = reference((await requestBody(c.req.raw)).ref);
    return c.json(await change(ref, () => mergeSkillUpdates(ref)));
  });
  app.post("/resolve-conflict", async (c) => {
    const body = await requestBody(c.req.raw);
    const ref = reference(body.ref);
    if (
      typeof body.path !== "string" ||
      typeof body.revision !== "string" ||
      !["work", "upstream"].includes(body.choice)
    )
      throw new ValueError(
        "Conflict path, choice and reviewed revision are required"
      );
    return c.json(
      await change(ref, () =>
        resolveSkillConflict(ref, body.path, body.choice, body.revision)
      )
    );
  });
  app.post("/reconcile-source", reviewedChange(reconcileSkillSource));
  app.get("/codex", (c) => {
    const ref = queryReference(c.req.raw);
    return c.json(codex(ref).state());
  });
  app.post("/codex/start", async (c) => {
    const body = await requestBody(c.req.raw);
    const ref = reference(body.ref);
    if (
      typeof body.prompt !== "string" ||
      !body.prompt.trim() ||
      body.prompt.length > 100_000
    )
      throw new ValueError("A prompt up to 100,000 characters is required");
    return c.json(await change(ref, () => codex(ref).start(body.prompt)));
  });
  app.post("/codex/interrupt", async (c) => {
    const ref = reference((await requestBody(c.req.raw)).ref);
    return c.json(await codex(ref).interrupt());
  });
  app.post("/codex/approve", async (c) => {
    const body = await requestBody(c.req.raw);
    const ref = reference(body.ref);
    if (
      (typeof body.id !== "number" && typeof body.id !== "string") ||
      !["accept", "decline"].includes(body.decision)
    )
      throw new ValueError("Invalid approval decision");
    return c.json(await codex(ref).approve(body.id, body.decision));
  });
  return app;
}
