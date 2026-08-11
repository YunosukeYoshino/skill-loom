type InventoryCustomSkillMetaV1 = {
  repoPath: string
  category: string
}

type InventoryExternalSkillMetaV1 = {
  source: string
  sourceUrl: string
  skillPath: string
  localRepoPath?: string
  installSkill?: string
  category?: string
}

type InventoryVendorSkillMetaV1 = {
  source: string
  sourceUrl?: string
  skillPath?: string
  localRepoPath?: string
}

export type InventoryLockV1 = {
  version: 1
  custom: {
    repo: string
    skills: Record<string, InventoryCustomSkillMetaV1>
  }
  external: Record<string, InventoryExternalSkillMetaV1>
  vendor: Record<string, InventoryVendorSkillMetaV1>
}

type JsonObject = Record<string, unknown>

function invalid(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "expected object")
  }
  return value as JsonObject
}

function required(object: JsonObject, key: string, path: string): unknown {
  if (!Object.hasOwn(object, key) || object[key] === undefined) return invalid(`${path}.${key}`, "is required")
  return object[key]
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") return invalid(path, "expected string")
  return value
}

function optionalString(object: JsonObject, key: string, path: string): string | undefined {
  if (!Object.hasOwn(object, key)) return undefined
  return stringAt(object[key], `${path}.${key}`)
}

function rejectUnknownKeys(object: JsonObject, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "unknown field")
  }
}

const ROOT_KEYS = new Set(["version", "custom", "external", "vendor"])
const CUSTOM_KEYS = new Set(["repo", "skills"])
const CUSTOM_META_KEYS = new Set(["repoPath", "category"])
const EXTERNAL_META_KEYS = new Set([
  "source",
  "sourceUrl",
  "skillPath",
  "localRepoPath",
  "installSkill",
  "category",
])
const VENDOR_META_KEYS = new Set(["source", "sourceUrl", "skillPath", "localRepoPath"])

function recordAt<T>(
  value: unknown,
  path: string,
  parseEntry: (value: unknown, path: string) => T,
): Record<string, T> {
  const object = objectAt(value, path)
  const entries: Array<[string, T]> = []
  for (const [name, metadata] of Object.entries(object)) {
    if (name.length === 0) invalid(path, "skill name must not be empty")
    entries.push([name, parseEntry(metadata, `${path}.${name}`)])
  }
  return Object.fromEntries(entries)
}

function parseCustomMeta(value: unknown, path: string): InventoryCustomSkillMetaV1 {
  const object = objectAt(value, path)
  rejectUnknownKeys(object, CUSTOM_META_KEYS, path)
  return {
    repoPath: stringAt(required(object, "repoPath", path), `${path}.repoPath`),
    category: stringAt(required(object, "category", path), `${path}.category`),
  }
}

function parseExternalMeta(value: unknown, path: string): InventoryExternalSkillMetaV1 {
  const object = objectAt(value, path)
  rejectUnknownKeys(object, EXTERNAL_META_KEYS, path)
  return {
    source: stringAt(required(object, "source", path), `${path}.source`),
    sourceUrl: stringAt(required(object, "sourceUrl", path), `${path}.sourceUrl`),
    skillPath: stringAt(required(object, "skillPath", path), `${path}.skillPath`),
    ...optionalMetadata(object, path, ["localRepoPath", "installSkill", "category"]),
  }
}

function parseVendorMeta(value: unknown, path: string): InventoryVendorSkillMetaV1 {
  const object = objectAt(value, path)
  rejectUnknownKeys(object, VENDOR_META_KEYS, path)
  return {
    source: stringAt(required(object, "source", path), `${path}.source`),
    ...optionalMetadata(object, path, ["sourceUrl", "skillPath", "localRepoPath"]),
  }
}

function optionalMetadata<const K extends string>(
  object: JsonObject,
  path: string,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = optionalString(object, key, path)
    if (value !== undefined) result[key] = value
  }
  return result
}

export function parseInventoryLock(value: unknown, source = "Inventory Lock"): InventoryLockV1 {
  const root = objectAt(value, source)
  rejectUnknownKeys(root, ROOT_KEYS, source)

  const version = required(root, "version", source)
  if (version !== 1) invalid(`${source}.version`, `unsupported version ${String(version)}; expected 1`)

  const customPath = `${source}.custom`
  const custom = objectAt(required(root, "custom", source), customPath)
  rejectUnknownKeys(custom, CUSTOM_KEYS, customPath)

  return {
    version,
    custom: {
      repo: stringAt(required(custom, "repo", customPath), `${customPath}.repo`),
      skills: recordAt(required(custom, "skills", customPath), `${customPath}.skills`, parseCustomMeta),
    },
    external: recordAt(required(root, "external", source), `${source}.external`, parseExternalMeta),
    vendor: recordAt(required(root, "vendor", source), `${source}.vendor`, parseVendorMeta),
  }
}
