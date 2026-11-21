import { Hono } from "hono";
import { AlreadyExistsError, ValueError } from "./domain/errors";
import { listProjectDecks } from "./domain/decks";
import { loadLock, trackedSkills } from "./domain/inventory";
import {
  listProjects,
  importProjectSkill,
  previewProjectSkill,
  projectSkillAction,
  projectStatus,
  registerProject,
  syncProject,
  unregisterProject,
} from "./domain/projects";

export function createProjectRoutes() {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AlreadyExistsError)
      return c.json({ message: error.message }, 409);
    if (error instanceof ValueError)
      return c.json({ message: error.message }, 400);
    throw error;
  });
  app.get("/", (c) =>
    c.json({
      projects: listProjects(),
      inventory: [...trackedSkills(loadLock())].sort(),
      decks: listProjectDecks(),
    })
  );
  app.post("/", async (c) => {
    const body = await projectBody(c.req.raw);
    if (
      typeof body.name !== "string" ||
      typeof body.path !== "string" ||
      (body.deck !== undefined && typeof body.deck !== "string")
    )
      throw new ValueError("Project name and path are required");
    return c.json(
      registerProject(body.name, body.path, body.deck as string | undefined),
      201
    );
  });
  app.get("/:name", (c) =>
    c.json(projectStatus(c.req.param("name"), loadLock()))
  );
  app.delete("/:name", (c) => {
    unregisterProject(c.req.param("name"));
    return c.json({ removed: c.req.param("name") });
  });
  app.get("/:name/skills/:skill/preview", (c) =>
    c.json(
      previewProjectSkill(c.req.param("name"), c.req.param("skill"), loadLock())
    )
  );
  app.post("/:name/sync", async (c) => {
    const body = await projectBody(c.req.raw);
    return c.json(
      syncProject(c.req.param("name"), loadLock(), {
        force: body.force === true,
        dryRun: body.dryRun === true,
        revision: typeof body.revision === "string" ? body.revision : undefined,
      })
    );
  });
  // fallow-ignore-next-line complexity
  app.post("/:name/skills/:skill/:action", async (c) => {
    const action = c.req.param("action");
    if (action === "import") {
      const body = await projectBody(c.req.raw);
      if (body.category !== undefined && typeof body.category !== "string")
        throw new ValueError("Invalid draft category");
      return c.json(
        importProjectSkill(
          c.req.param("name"),
          c.req.param("skill"),
          loadLock(),
          body.category as string | undefined
        )
      );
    }
    if (action !== "install" && action !== "update" && action !== "remove")
      return c.json({ message: "Not found" }, 404);
    const body = await projectBody(c.req.raw);
    if (action === "remove" && body.confirm !== true)
      throw new ValueError("Removal confirmation is required");
    const lock = loadLock();
    if (action === "update") {
      const preview = previewProjectSkill(
        c.req.param("name"),
        c.req.param("skill"),
        lock
      );
      if (
        preview.requiresConfirmation &&
        (body.confirm !== true || body.revision !== preview.revision)
      )
        return c.json(
          { message: "Review the diff before confirming", preview },
          409
        );
    }
    return c.json(
      projectSkillAction(
        c.req.param("name"),
        c.req.param("skill"),
        action,
        lock,
        body.force === true,
        typeof body.revision === "string" ? body.revision : undefined
      )
    );
  });
  return app;
}

async function projectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new ValueError("A JSON object is required");
  }
}
