import { expect, test } from "bun:test";
import { Hono } from "hono";
import { localRequestGuard, requestOriginError } from "./requestGuard";

function guarded(): { app: Hono; calls: () => number } {
  let count = 0;
  const app = new Hono();
  app.use("/api/*", localRequestGuard);
  app.post("/api/external/install", (c) => {
    count++;
    return c.json({ ok: true });
  });
  app.get("/api/global", (c) => c.json({ ok: true }));
  return { app, calls: () => count };
}

function install(
  app: Hono,
  headers: Record<string, string>,
  host = "localhost"
) {
  return app.request(`http://${host}:8765/api/external/install`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: "attacker/repo" }),
  });
}

test("cross-site POST is rejected before reaching the route", async () => {
  const { app, calls } = guarded();
  const response = await install(app, {
    "content-type": "application/json",
    "sec-fetch-site": "cross-site",
  });
  expect(response.status).toBe(403);
  expect(calls()).toBe(0);
});

test("text/plain POST is rejected as a non-JSON simple request", async () => {
  const { app, calls } = guarded();
  const response = await install(app, {
    "content-type": "text/plain;charset=UTF-8",
    "sec-fetch-site": "same-origin",
  });
  expect(response.status).toBe(415);
  expect(calls()).toBe(0);
});

test("POST from a foreign Origin is rejected", async () => {
  const { app } = guarded();
  const response = await install(app, {
    "content-type": "application/json",
    origin: "https://evil.example",
  });
  expect(response.status).toBe(403);
});

test("POST to a non-local Host is rejected (DNS rebinding)", async () => {
  const { app } = guarded();
  const response = await install(
    app,
    { "content-type": "application/json" },
    "evil.example"
  );
  expect(response.status).toBe(403);
});

test("same-origin JSON POST and plain GET pass through", async () => {
  const { app, calls } = guarded();
  const post = await install(app, {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    origin: "http://localhost:8765",
  });
  expect(post.status).toBe(200);
  expect(calls()).toBe(1);
  const get = await app.request("http://skill-loom.localhost/api/global");
  expect(get.status).toBe(200);
});

test("WebSocket upgrade origin check rejects foreign pages", () => {
  const upgrade = (origin: string) =>
    new Request("http://localhost:8765/", {
      headers: { upgrade: "websocket", origin },
    });
  expect(requestOriginError(upgrade("https://evil.example"))).toBeDefined();
  expect(requestOriginError(upgrade("http://localhost:8765"))).toBeUndefined();
});
