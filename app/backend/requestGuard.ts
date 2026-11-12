import type { MiddlewareHandler } from "hono";

function localHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

function originHeaderError(
  origin: string | null,
  host: string
): string | undefined {
  if (!origin) return undefined;
  try {
    if (new URL(origin).host !== host)
      return "Cross-origin requests are not accepted";
  } catch {
    return "Invalid origin";
  }
}

/** Host・Sec-Fetch-Site・Origin が同じローカル UI から来たものかを確かめる。 */
export function requestOriginError(request: Request): string | undefined {
  const url = new URL(request.url);
  if (!localHost(url.hostname))
    return "Only local Skill Loom requests are accepted";
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    return "Cross-site requests are not accepted";
  return originHeaderError(request.headers.get("origin"), url.host);
}

/** cross-site と、プリフライトを経ない JSON 以外の状態変更を拒む。 */
export const localRequestGuard: MiddlewareHandler = async (c, next) => {
  const originError = requestOriginError(c.req.raw);
  if (originError) return c.json({ message: originError }, 403);
  if (
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    !(c.req.header("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    return c.json({ message: "JSON content type is required" }, 415);
  await next();
};
