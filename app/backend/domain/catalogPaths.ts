import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { catalogRoot } from "./config"
import { ValueError } from "./errors"

/** Resolve one Inventory Lock path against the selected Catalog Root. */
export function resolveCatalogPath(relativePath: string): string {
  if (isAbsolute(relativePath)) throw new ValueError(`Catalog path must be relative: ${relativePath}`)
  const root = resolve(catalogRoot())
  const candidate = resolve(root, relativePath)
  assertWithinCatalog(root, candidate, relativePath)

  const realRoot = canonicalPath(root)
  const realCandidate = canonicalPath(candidate)
  assertWithinCatalog(realRoot, realCandidate, relativePath)
  return realCandidate
}

function assertWithinCatalog(root: string, candidate: string, input: string): void {
  const fromRoot = relative(root, candidate)
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ValueError(`Catalog path must stay within Catalog Root: ${input}`)
  }
}

/** Resolve symlinks in the nearest existing ancestor, including for a missing leaf. */
function canonicalPath(path: string): string {
  let ancestor = path
  const missing: string[] = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return path
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...missing)
}
