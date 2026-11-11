import type {
  SkillCodexState,
  SkillRef,
  SkillVersion,
  SkillView,
} from "@shared/skill-workspace-types";

async function request<T>(
  path: string,
  body?: object,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(`/api/skill${path}`, {
    signal,
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return response.json().catch(() => {
    throw new Error(`Invalid API response (${response.status})`);
  }) as Promise<T>;
}

async function requestError(response: Response): Promise<Error> {
  const error = await response.json().catch(() => ({}));
  return new Error(
    typeof error?.message === "string"
      ? error.message
      : `Request failed (${response.status})`
  );
}

function query(ref: SkillRef, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ name: ref.name, ...extra });
  if (ref.source) params.set("source", ref.source);
  if (ref.skillPath) params.set("skillPath", ref.skillPath);
  return params;
}

export type SkillAction =
  | "fork"
  | "save"
  | "validate"
  | "apply"
  | "discard"
  | "check-upstream"
  | "merge-upstream"
  | "reconcile-source"
  | "resolve-conflict";

export const skillWorkspaceApi = {
  view: (
    ref: SkillRef,
    version: SkillVersion,
    file: string,
    signal?: AbortSignal
  ) =>
    request<SkillView>(`?${query(ref, { version, file })}`, undefined, signal),
  action: (
    action: SkillAction,
    ref: SkillRef,
    fields?: {
      path?: string;
      content?: string;
      revision?: string;
      choice?: "work" | "upstream";
    }
  ) => request<SkillView>(`/${action}`, { ref, ...fields }),
  preview: (content: string, signal?: AbortSignal) =>
    request<{ html: string }>("/preview", { content }, signal),
  codex: (ref: SkillRef, signal?: AbortSignal) =>
    request<SkillCodexState>(`/codex?${query(ref)}`, undefined, signal),
  start: (ref: SkillRef, prompt: string) =>
    request<SkillCodexState>("/codex/start", { ref, prompt }),
  interrupt: (ref: SkillRef) =>
    request<SkillCodexState>("/codex/interrupt", { ref }),
  approve: (
    ref: SkillRef,
    id: string | number,
    decision: "accept" | "decline"
  ) => request<SkillCodexState>("/codex/approve", { ref, id, decision }),
};
