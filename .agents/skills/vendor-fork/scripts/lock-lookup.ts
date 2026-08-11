#!/usr/bin/env bun
/**
 * Inventory / global lock から source を照会する TypeScript CLI。
 *
 * 使い方:
 *   bun lock-lookup.ts external-source <lock-file> <skill-name>
 *   bun lock-lookup.ts global-source <skill-name>
 */

import fs from "node:fs"
import os from "node:os"
import process from "node:process"

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf-8"))
}

function externalSource(lockFile: string, skillName: string): string {
  const lock = readJson(lockFile) as { external?: Record<string, { source?: unknown }> }
  const source = lock.external?.[skillName]?.source
  return typeof source === "string" ? source : ""
}

function globalSource(skillName: string): string {
  const lockPath = `${os.homedir()}/.agents/.skill-lock.json`
  const lock = readJson(lockPath) as { skills?: Record<string, { source?: unknown }> }
  const source = lock.skills?.[skillName]?.source
  return typeof source === "string" ? source : ""
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "external-source") {
    const [lockFile, skillName] = rest
    if (!lockFile || !skillName) {
      console.error("Error: usage: lock-lookup.ts external-source <lock-file> <skill-name>")
      process.exit(2)
    }
    try {
      process.stdout.write(`${externalSource(lockFile, skillName)}\n`)
    } catch {
      process.stdout.write("\n")
    }
    return
  }
  if (command === "global-source") {
    const [skillName] = rest
    if (!skillName) {
      console.error("Error: usage: lock-lookup.ts global-source <skill-name>")
      process.exit(2)
    }
    try {
      const source = globalSource(skillName)
      process.stdout.write(source ? `Source: ${source}\n` : "Source: NOT FOUND\n")
    } catch {
      process.stdout.write("Source: NOT FOUND\n")
    }
    return
  }
  console.error("Error: usage: lock-lookup.ts <external-source|global-source> ...")
  process.exit(2)
}

if (import.meta.main) {
  main()
}
