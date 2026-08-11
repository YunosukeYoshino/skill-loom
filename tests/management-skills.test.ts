/**
 * 管理スキルのシェル entrypoint 統合テスト。
 *
 * 旧 Python ハーネス tests/test_skill_management_scripts.py を置き換える Bun テスト。
 * 実 bash オーケストレーションを走らせ、外部コマンドはテスト用 stub に差し替える。
 * Python/uv には依存しない。
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(__dirname, "..")

const MANAGEMENT_SKILLS = ["skills-add", "skills-check", "skills-restore", "check-vendor-updates", "vendor-fork", "skill-deck-manager"]

const SKILLS_RESTORE = path.join(REPO_ROOT, ".agents/skills/skills-restore/scripts/skills-restore")
const SKILLS_ADD_DIR = path.join(REPO_ROOT, ".agents/skills/skills-add/scripts")
const VENDOR_FORK = path.join(REPO_ROOT, ".agents/skills/vendor-fork/scripts/skills-vendor-fork")
const VENDOR_AUDIT = path.join(REPO_ROOT, ".agents/skills/vendor-fork/scripts/skills-audit-vendor")
const VENDOR_SYNC = path.join(REPO_ROOT, ".agents/skills/vendor-fork/scripts/skills-sync-upstream")

function runBash(script: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { exitCode: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...(opts.env ?? {}) }
  const result = Bun.spawnSync(["bash", script, ...args], { cwd: opts.cwd ?? REPO_ROOT, env })
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe("management skill docs", () => {
  test("public 管理スキルは Catalog 名のつかない一般 api を指し、private repo / git push を含まない", () => {
    const privateRepo = "Yunosuke" + "Yoshino/my-skills"
    for (const name of MANAGEMENT_SKILLS) {
      const text = fs.readFileSync(path.join(REPO_ROOT, ".agents/skills", name, "SKILL.md"), "utf-8")
      expect(text.includes("CATALOG_ROOT") || text.includes("MY_SKILLS_CATALOG_DIR")).toBe(true)
      expect(text.includes(privateRepo)).toBe(false)
      expect(text.includes("git push")).toBe(false)
    }
  })
})

describe("skills-restore", () => {
  test("dry-run で selected catalog の外部/custom/agents を plan する", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-restore-"))
    const catalog = path.join(root, "catalog")
    fs.mkdirSync(path.join(catalog, "agents"), { recursive: true })
    fs.writeFileSync(path.join(catalog, "agents", "catalog-agent.md"), "catalog agent\n")
    fs.writeFileSync(
      path.join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        external: { external: { source: "owner/external", sourceUrl: "https://github.com/owner/external.git", skillPath: "skills/external/SKILL.md" } },
        vendor: {},
      }),
    )

    const out = runBash(SKILLS_RESTORE, ["--catalog-dir", catalog, "--dry-run"], { env: { HOME: path.join(root, "home") } })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain("npx skills add owner/external --skill external")
    expect(out.stdout).toContain("npx skills add owner/catalog --skill *")
    expect(out.stdout).toContain(path.join(catalog, "agents"))
  })
})

describe("skills-vendor-fork", () => {
  test("selected catalog が vendor と upstream の実体を保有する", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-fork-"))
    const catalog = path.join(root, "catalog")
    fs.mkdirSync(catalog)
    const installed = path.join(root, "home", ".agents", "skills", "catalog-vendor-fixture")
    fs.mkdirSync(installed, { recursive: true })
    fs.writeFileSync(path.join(installed, "SKILL.md"), "---\nname: catalog-vendor-fixture\n---\n")

    const out = runBash(VENDOR_FORK, ["--catalog-dir", catalog, "catalog-vendor-fixture"], { env: { HOME: path.join(root, "home") } })
    expect(out.exitCode).toBe(0)
    expect(fs.existsSync(path.join(catalog, "vendor/catalog-vendor-fixture/SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(catalog, "upstream/catalog-vendor-fixture/SKILL.md"))).toBe(true)
  })

  test("audit は selected catalog の vendor/upstream から diff を読む", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-audit-"))
    const catalog = path.join(root, "catalog")
    const upstream = path.join(catalog, "upstream/catalog-audit-fixture")
    const vendor = path.join(catalog, "vendor/catalog-audit-fixture")
    fs.mkdirSync(upstream, { recursive: true })
    fs.mkdirSync(vendor, { recursive: true })
    fs.writeFileSync(path.join(upstream, "SKILL.md"), "upstream\n")
    fs.writeFileSync(path.join(vendor, "SKILL.md"), "vendor\n")

    const out = runBash(VENDOR_AUDIT, ["--catalog-dir", catalog], {})
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain("CHANGED: catalog-audit-fixture")
  })

  test("sync は selected catalog の upstream を更新する", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-sync-"))
    const catalog = path.join(root, "catalog")
    const vendor = path.join(catalog, "vendor/catalog-sync-fixture")
    const upstream = path.join(catalog, "upstream/catalog-sync-fixture")
    fs.mkdirSync(vendor, { recursive: true })
    fs.mkdirSync(upstream, { recursive: true })
    fs.writeFileSync(path.join(vendor, "SKILL.md"), "vendor\n")
    fs.writeFileSync(path.join(upstream, "SKILL.md"), "old upstream\n")
    fs.writeFileSync(
      path.join(catalog, "skills.lock.json"),
      JSON.stringify({
        version: 1,
        custom: { repo: "owner/catalog", skills: {} },
        external: { "catalog-sync-fixture": { source: "owner/upstream", sourceUrl: "https://github.com/owner/upstream.git", skillPath: "skills/catalog-sync-fixture/SKILL.md" } },
        vendor: {},
      }),
    )
    const stub = path.join(root, "skills-stub")
    fs.writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'target="$HOME/.agents/skills/catalog-sync-fixture"',
        'mkdir -p "$target"',
        "printf 'new upstream\\n' > \"$target/SKILL.md\"",
      ].join("\n"),
    )
    fs.chmodSync(stub, 0o755)
    const trashStub = path.join(root, "trash-stub")
    fs.writeFileSync(trashStub, '#!/usr/bin/env bash\nset -euo pipefail\nfor p in "$@"; do mv -- "$p" "$p.trashed"; done\n')
    fs.chmodSync(trashStub, 0o755)

    const out = runBash(VENDOR_SYNC, ["--catalog-dir", catalog], { env: { MY_SKILLS_ADD_BIN: stub, MY_SKILLS_TRASH_BIN: trashStub } })
    expect(out.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(upstream, "SKILL.md"), "utf-8")).toBe("new upstream\n")
  })
})

describe("skills-add", () => {
  test("filter / ignore / fallback / link / no-commit の bash オーケストレーション", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-add-"))
    const repo = path.join(tmp, "repo")
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", REPO_ROOT, repo])
    expect(clone.exitCode).toBe(0)

    for (const rel of [
      ".agents/skills/skills-add/scripts/normalize-github-url.ts",
      ".agents/skills/skills-add/scripts/resolve-skill-path.ts",
      ".agents/skills/skills-add/scripts/register-skill-lock.ts",
      ".agents/skills/skills-add/scripts/lock-check.ts",
      ".agents/skills/skills-add/scripts/run-skills-cli.sh",
      ".agents/skills/skills-add/scripts/skills-add",
    ]) {
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(repo, rel))
    }

    const catalog = path.join(tmp, "catalog")
    fs.mkdirSync(catalog)
    const lockFile = path.join(catalog, "skills.lock.json")
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        version: 3,
        custom: { skills: { local: { repoPath: "skills/local" } } },
        external: { existing: { source: "old/repo", sourceUrl: "https://github.com/old/repo.git", skillPath: "skills/existing/SKILL.md" } },
        vendor: { managed: { source: "upstream/repo" } },
      }),
    )
    fs.writeFileSync(path.join(catalog, ".skills-ignore.json"), JSON.stringify({ ignore: ["ignored"] }))

    const home = path.join(tmp, "home")
    const active = path.join(home, ".agents", "skills")
    fs.mkdirSync(active, { recursive: true })
    fs.mkdirSync(path.join(active, "existing"))
    fs.writeFileSync(path.join(active, "existing", "SKILL.md"), "---\nname: existing\n---\n")
    const claude = path.join(tmp, "claude-skills")
    const gemini = path.join(tmp, "gemini-skills")

    const binDir = path.join(tmp, "bin")
    fs.mkdirSync(binDir)
    const skillsStub = path.join(binDir, "skills-stub")
    fs.writeFileSync(
      skillsStub,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'target="$HOME/.agents/skills"',
        'for ((i=1; i <= $#; i++)); do',
        '  if [ "${!i}" = "--skill" ]; then',
        '    j=$((i+1))',
        '    name="${!j}"',
        '    mkdir -p "$target/$name"',
        "printf -- '---\\nname: %s\\ndescription: fixture\\n---\\n' \"$name\" > \"$target/$name/SKILL.md\"",
        "  fi",
        "done",
      ].join("\n"),
    )
    fs.chmodSync(skillsStub, 0o755)

    const ghStub = path.join(binDir, "gh")
    const encoded = Buffer.from("---\nname: alpha\ndescription: fixture\n---\n", "utf-8").toString("base64")
    fs.writeFileSync(
      ghStub,
      [
        "#!/usr/bin/env bash",
        'endpoint="${@: -1}"',
        'if [[ "$endpoint" == *"/git/trees/"* ]]; then',
        "  echo '{\"tree\": [{\"path\": \"packs/alpha/SKILL.md\", \"type\": \"blob\"}]}'",
        `elif [[ "$endpoint" == *"/contents/packs/alpha/SKILL.md" ]]; then`,
        `  echo '{"content": "${encoded}"}'`,
        "else",
        "  exit 1",
        "fi",
      ].join("\n"),
    )
    fs.chmodSync(ghStub, 0o755)

    function revParse(): string {
      const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"])
      return r.stdout.toString().trim()
    }
    const beforeHead = revParse()
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MY_SKILLS_ADD_BIN: skillsStub,
      MY_SKILLS_CATALOG_DIR: catalog,
      MY_SKILLS_ACTIVE_DIR: active,
      MY_SKILLS_CLAUDE_SKILLS_DIR: claude,
      MY_SKILLS_GEMINI_SKILLS_DIR: gemini,
    }
    const result = runBash(path.join(repo, ".agents/skills/skills-add/scripts/skills-add"), ["git@github.com:owner/repo.git", "--skill", "alpha", "--skill", "ignored", "--skill", "existing", "--skill", "fallback", "--no-commit"], { cwd: repo, env })
    expect(result.exitCode).toBe(0)

    const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as Record<string, unknown>
    expect(lock["version"]).toBe(3)
    const custom = lock["custom"] as Record<string, unknown>
    expect(Object.keys((custom["skills"] as Record<string, unknown>) ?? {})).toContain("local")
    const vendor = lock["vendor"] as Record<string, unknown>
    expect(Object.keys(vendor)).toContain("managed")
    const extLock = lock["external"] as Record<string, Record<string, unknown>>
    expect(extLock["existing"]?.["source"]).toBe("old/repo")
    expect(extLock["alpha"]?.["skillPath"]).toBe("packs/alpha/SKILL.md")
    expect(extLock["fallback"]?.["skillPath"]).toBe("skills/fallback/SKILL.md")
    expect(extLock["ignored"]).toBeUndefined()
    expect(extLock["beta"]).toBeUndefined()

    for (const agentDir of [claude, gemini]) {
      expect(fs.lstatSync(path.join(agentDir, "alpha")).isSymbolicLink()).toBe(true)
      expect(fs.lstatSync(path.join(agentDir, "fallback")).isSymbolicLink()).toBe(true)
      expect(fs.realpathSync(path.join(agentDir, "alpha"))).toBe(fs.realpathSync(path.join(active, "alpha")))
      expect(fs.realpathSync(path.join(agentDir, "fallback"))).toBe(fs.realpathSync(path.join(active, "fallback")))
    }

    const afterHead = revParse()
    expect(afterHead).toBe(beforeHead)
  })
})