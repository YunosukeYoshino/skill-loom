#!/usr/bin/env bun
/**
 * Inventory Lock の排他的な read-modify-write。
 * mkdir ベースのロックを取得してから再読込し、一意な一時ファイルへ書いて rename する。
 */

import fs from "node:fs"
import path from "node:path"

export type LockObject = Record<string, unknown>

function sleepMs(ms: number): void {
  Bun.sleepSync(ms)
}

function acquireDirLock(lockDir: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      fs.mkdirSync(lockDir)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      if (Date.now() >= deadline) {
        throw new Error(`Timeout acquiring lock directory: ${lockDir}`)
      }
      sleepMs(20)
    }
  }
}

function releaseDirLock(lockDir: string): void {
  try {
    fs.rmdirSync(lockDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw error
  }
}

export function readLockObject(lockPath: string): LockObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
  } catch {
    throw new Error(`Cannot read or parse lock file: ${lockPath}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Lock file is not a JSON object: ${lockPath}`)
  }
  return parsed as LockObject
}

function atomicWrite(lockPath: string, lock: LockObject): void {
  const dir = path.dirname(lockPath)
  const tmp = path.join(dir, `.skills.lock.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`)
  fs.renameSync(tmp, lockPath)
}

/**
 * 排他ロック下で Inventory Lock を再読込→変異→原子的保存する。
 */
export function updateInventoryLock(lockPath: string, mutate: (lock: LockObject) => void): LockObject {
  const absPath = path.resolve(lockPath)
  const lockDir = `${absPath}.lockdir`
  acquireDirLock(lockDir)
  try {
    const lock = readLockObject(absPath)
    mutate(lock)
    atomicWrite(absPath, lock)
    return lock
  } finally {
    releaseDirLock(lockDir)
  }
}
