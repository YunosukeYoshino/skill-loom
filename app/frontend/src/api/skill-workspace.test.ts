import { afterEach, expect, mock, test } from "bun:test";
import { skillWorkspaceApi } from "./skill-workspace";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("workspace references and file paths use query encoding and retain cancellation", async () => {
  const signal = new AbortController().signal;
  const fetchMock = mock(async (..._args: Parameters<typeof fetch>) =>
    Response.json({ revision: "snapshot" })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const result = await skillWorkspaceApi.view(
    {
      name: "example",
      source: "owner/repo",
      skillPath: "skills/example/SKILL.md",
    },
    "work",
    "references/a b.md",
    signal
  );
  expect(result.revision).toBe("snapshot");
  expect(fetchMock.mock.calls[0]).toEqual([
    "/api/skill?name=example&version=work&file=references%2Fa+b.md&source=owner%2Frepo&skillPath=skills%2Fexample%2FSKILL.md",
    { signal },
  ]);
});

test("save sends the reviewed revision and exact content as JSON", async () => {
  const fetchMock = mock(async (..._args: Parameters<typeof fetch>) =>
    Response.json({ revision: "saved" })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const ref = { name: "example" };
  const fields = {
    path: "SKILL.md",
    content: "---\ninvalid: yaml: preserved",
    revision: "reviewed",
  };
  await skillWorkspaceApi.action("save", ref, fields);
  expect(fetchMock.mock.calls[0]).toEqual([
    "/api/skill/save",
    {
      signal: undefined,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, ...fields }),
    },
  ]);
});

test("workspace errors preserve server messages and handle non-JSON failures", async () => {
  for (const body of [
    '{"message":"Working copy changed"}',
    "null",
    "not-json",
  ]) {
    globalThis.fetch = mock(
      async () => new Response(body, { status: 409 })
    ) as unknown as typeof fetch;
    const expected = body.startsWith("{")
      ? "Working copy changed"
      : "Request failed (409)";
    await expect(
      skillWorkspaceApi.action("validate", { name: "example" })
    ).rejects.toThrow(expected);
  }
});

test("a non-JSON success remains a failed request", async () => {
  globalThis.fetch = mock(
    async () => new Response("<html>SPA fallback</html>")
  ) as unknown as typeof fetch;
  await expect(skillWorkspaceApi.codex({ name: "example" })).rejects.toThrow(
    "Invalid API response (200)"
  );
});
