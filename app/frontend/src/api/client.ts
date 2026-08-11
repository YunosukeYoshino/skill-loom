import type {
  DraftsPayload,
  ExternalPreviewPayload,
  ExternalSourceDetailPayload,
  ExternalSourcesPayload,
  GlobalPayload,
  OgpPayload,
  ProjectDeckPayload,
  Tristate,
} from "@shared/api-types"

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  })
  const contentType = res.headers.get("content-type") || ""
  const text = await res.text()
  const trimmed = text.trimStart()
  const looksJson = contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[")

  let body: unknown = {}
  if (text.length > 0 && looksJson) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(res.status, `Invalid JSON response (${res.status})`, text.slice(0, 200))
    }
  } else if (res.ok) {
    // Vite 直叩きなどで SPA index（text/html）が 200 で返ると、旧実装は {} を成功扱いし
    // ExternalSourcesPage などが undefined.map で落ちていた。
    const hint = contentType.includes("text/html")
      ? "API returned HTML instead of JSON. Open the Skill Loom UI public port (skill-loom ui / --dev), not the Vite port."
      : `Unexpected non-JSON response (${res.status})`
    throw new ApiError(res.status, hint, text.slice(0, 200))
  }

  if (!res.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `Request failed (${res.status})`
    throw new ApiError(res.status, message, body)
  }
  return body as T
}

export const api = {
  global: (catalog = false) =>
    request<GlobalPayload>(`/api/global${catalog ? "?catalog=1" : ""}`),

  apply: (states: Record<string, Tristate>) =>
    request<GlobalPayload>("/api/apply", {
      method: "POST",
      body: JSON.stringify({ states }),
    }),

  bulkOff: () =>
    request<GlobalPayload>("/api/bulk-off", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  previewPreset: (name: string) => request<GlobalPayload>(`/api/presets/${encodeURIComponent(name)}/preview`),

  savePreset: (name: string, overwrite = false, description = "") =>
    request<GlobalPayload>("/api/presets/save", {
      method: "POST",
      body: JSON.stringify({ name, overwrite, description }),
    }),

  applyPreset: (name: string, confirm = false) =>
    request<GlobalPayload>("/api/presets/apply", {
      method: "POST",
      body: JSON.stringify({ name, confirm }),
    }),

  restorePreset: (confirm = false) =>
    request<GlobalPayload>("/api/presets/restore", {
      method: "POST",
      body: JSON.stringify({ confirm }),
    }),

  deletePreset: (name: string) =>
    request<GlobalPayload>("/api/presets/delete", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  checkCustomUpdates: () =>
    request<GlobalPayload>("/api/custom/check-updates", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  updateCustomSkill: (skill: string) =>
    request<GlobalPayload>("/api/custom/update", {
      method: "POST",
      body: JSON.stringify({ skill }),
    }),

  updateAllCustomSkills: (skills?: string[]) =>
    request<GlobalPayload>("/api/custom/update-all", {
      method: "POST",
      body: JSON.stringify(skills ? { skills } : {}),
    }),

  externalSources: () => request<ExternalSourcesPayload>("/api/external-sources"),

  externalSource: (source: string) =>
    request<ExternalSourceDetailPayload>(`/api/external-sources/${source}`),

  ogp: (source: string) => request<OgpPayload>(`/api/ogp/${source}`),

  checkUpdates: (source: string) =>
    request<ExternalSourceDetailPayload>("/api/external-sources/check-updates", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),

  checkAllUpdates: () =>
    request<ExternalSourcesPayload>("/api/external-sources/check-all-updates", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  updateSkill: (skill: string) =>
    request<ExternalSourcesPayload>("/api/external-sources/update", {
      method: "POST",
      body: JSON.stringify({ skill }),
    }),

  updateAll: (source?: string) =>
    request<ExternalSourcesPayload | ExternalSourceDetailPayload>("/api/external-sources/update-all", {
      method: "POST",
      body: JSON.stringify({ source: source || "" }),
    }),

  removeSkill: (skill: string) =>
    request<ExternalSourcesPayload>("/api/external-sources/remove", {
      method: "POST",
      body: JSON.stringify({ skill }),
    }),

  previewExternal: (source: string, deck = "") =>
    request<ExternalPreviewPayload>("/api/external/preview", {
      method: "POST",
      body: JSON.stringify({ source, deck }),
    }),

  installExternal: (source: string, skills: string[], deck = "") =>
    request<GlobalPayload | ProjectDeckPayload>("/api/external/install", {
      method: "POST",
      body: JSON.stringify({ source, skills, deck }),
    }),

  addToDeck: (source: string, skills: string[], deck: string) =>
    request<ProjectDeckPayload>("/api/external/add-to-deck", {
      method: "POST",
      body: JSON.stringify({ source, skills, deck }),
    }),

  drafts: () => request<DraftsPayload>("/api/drafts"),

  draftsAction: (action: string, skills: string[]) =>
    request<DraftsPayload>(`/api/drafts/${action}`, {
      method: "POST",
      body: JSON.stringify({ skills }),
    }),

  projectDeck: (deckName: string, catalog = false) =>
    request<ProjectDeckPayload>(`/api/project-decks/${deckName}${catalog ? "?catalog=1" : ""}`),

  projectDeckAction: (deckName: string, action: string, skills: string[]) =>
    request<ProjectDeckPayload>(`/api/project-decks/${deckName}/${action}`, {
      method: "POST",
      body: JSON.stringify({ skills }),
    }),
}
