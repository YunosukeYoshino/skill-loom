#!/usr/bin/env bun
/**
 * normalize-github-url — GitHub URL を owner/repo 形式に正規化する（TypeScript 版）
 *
 * Python 版 normalize-github-url.py を挙動互換で置き換える。
 * コマンドライン契約（args・stdout・stderr・exit code）は不変。
 *
 * 使い方:
 *   bun lib/normalize-github-url.ts <url-or-owner/repo>
 *
 * 例:
 *   bun lib/normalize-github-url.ts https://github.com/better-auth/skills.git
 *   → better-auth/skills
 */

import process from "node:process"

/**
 * GitHub URL を owner/repo 形式へ正規化する。解析できない場合は null を返す。
 * Python 版の re.match パターンと同じ意味論を保持する。
 */
export function normalizeGithubUrl(url: string): string | null {
  const m = url.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
  )
  if (!m) return null
  return m[1]
}

function main(): void {
  const url = process.argv[2]
  if (url === undefined) {
    console.error("Error: Missing GitHub URL argument")
    process.exit(2)
  }
  const ownerRepo = normalizeGithubUrl(url)
  if (ownerRepo === null) {
    console.error(`Error: Cannot parse GitHub URL: ${url}`)
    process.exit(1)
  }
  process.stdout.write(`${ownerRepo}\n`)
}

if (import.meta.main) {
  main()
}