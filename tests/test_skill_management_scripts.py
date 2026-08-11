#!/usr/bin/env python3
"""Unit tests for skill management helper scripts."""

import base64
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
CHECK_SKILLS = REPO_ROOT / ".agents/skills/skills-check/scripts/check-skills.py"
RESTORE_LOCK = REPO_ROOT / ".agents/skills/skills-restore/scripts/restore-lock.py"
SKILLS_RESTORE = REPO_ROOT / ".agents/skills/skills-restore/scripts/skills-restore"
REGISTER_UNMANAGED = REPO_ROOT / ".agents/skills/check-vendor-updates/scripts/register_unmanaged.py"
SKILLS_ADD_DIR = REPO_ROOT / ".agents/skills/skills-add/scripts"
NORMALIZE_GITHUB_URL = SKILLS_ADD_DIR / "normalize-github-url.py"
RESOLVE_SKILL_PATH = SKILLS_ADD_DIR / "resolve-skill-path.py"
REGISTER_SKILL_LOCK = SKILLS_ADD_DIR / "register-skill-lock.py"
VENDOR_FORK = REPO_ROOT / ".agents/skills/vendor-fork/scripts/skills-vendor-fork"
VENDOR_AUDIT = REPO_ROOT / ".agents/skills/vendor-fork/scripts/skills-audit-vendor"
VENDOR_SYNC = REPO_ROOT / ".agents/skills/vendor-fork/scripts/skills-sync-upstream"
MANAGEMENT_SKILLS = (
    "skills-add",
    "skills-check",
    "skills-restore",
    "check-vendor-updates",
    "vendor-fork",
    "skill-deck-manager",
)


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ManagementSkillDocsTests(unittest.TestCase):
    def test_public_management_skills_name_catalog_without_private_repo_operations(self):
        private_repo = "Yunosuke" + "Yoshino/my-skills"
        for name in MANAGEMENT_SKILLS:
            with self.subTest(skill=name):
                text = (REPO_ROOT / ".agents/skills" / name / "SKILL.md").read_text()
                self.assertTrue("CATALOG_ROOT" in text or "MY_SKILLS_CATALOG_DIR" in text)
                self.assertNotIn(private_repo, text)
                self.assertNotIn("git push", text)


class CheckSkillsTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module(CHECK_SKILLS, "check_skills")

    def test_repo_defaults_use_repo_root_files(self):
        defaults = self.module.repo_defaults()
        self.assertEqual(defaults["lock_file"], REPO_ROOT / "skills.lock.json")
        self.assertEqual(defaults["ignore_file"], REPO_ROOT / ".skills-ignore.json")

    def test_repo_defaults_prefer_selected_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp) / "catalog"
            catalog.mkdir()
            with patch.dict(os.environ, {"MY_SKILLS_CATALOG_DIR": str(catalog)}):
                defaults = self.module.repo_defaults()

            self.assertEqual(defaults["lock_file"], catalog.resolve() / "skills.lock.json")
            self.assertEqual(defaults["ignore_file"], catalog.resolve() / ".skills-ignore.json")

    def test_classify_treats_repo_lock_custom_and_external(self):
        lock = {
            "custom": {
                "repo": "owner/catalog",
                "skills": {"alpha": {"repoPath": "skills/a/alpha", "category": "a"}},
            },
            "external": {
                "beta": {"source": "owner/repo"},
            },
            "vendor": {},
        }
        custom, external, ignored, unmanaged_agents, unmanaged_claude = self.module.classify(
            lock,
            {"superpowers"},
            {"alpha", "beta", "superpowers", "unknown"},
            {"alpha", "unknown"},
        )
        self.assertIn("alpha", custom)
        self.assertEqual(external["owner/repo"][0]["name"], "beta")
        self.assertIn("superpowers", ignored)
        self.assertIn("unknown", unmanaged_agents)
        self.assertIn("unknown", unmanaged_claude)

    def test_load_ignore_reads_repo_root_ignore_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ignore_file = Path(tmp) / ".skills-ignore.json"
            ignore_file.write_text(json.dumps({"ignore": ["superpowers"]}))
            ignored = self.module.load_ignore(ignore_file)
            self.assertEqual(ignored, {"superpowers"})

    def test_load_lock_ignored_merges_lock_ignored_array(self):
        lock = {"ignored": ["plugin-skill"]}
        ignored = self.module.load_lock_ignored(lock)
        self.assertEqual(ignored, {"plugin-skill"})

    def test_classify_treats_lock_ignored_as_ignored(self):
        lock = {
            "custom": {"repo": "owner/catalog", "skills": {}},
            "external": {},
            "vendor": {},
            "ignored": ["plugin-skill"],
        }
        _, _, ignored, unmanaged_agents, _ = self.module.classify(
            lock,
            set(),
            {"plugin-skill"},
            set(),
        )
        self.assertIn("plugin-skill", ignored)
        self.assertNotIn("plugin-skill", unmanaged_agents)


class RestoreLockTests(unittest.TestCase):
    def test_install_skill_field_is_used_for_npx_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "skills.lock.json"
            lock_file.write_text(
                json.dumps(
                    {
                        "external": {
                            "json-render": {
                                "source": "vercel-labs/json-render",
                                "installSkill": "react",
                            },
                            "defuddle": {
                                "source": "kepano/obsidian-skills",
                            },
                        }
                    }
                )
            )
            output = subprocess.check_output(
                [sys.executable, str(RESTORE_LOCK), str(lock_file)],
                text=True,
            )
            self.assertIn(
                "npx skills add vercel-labs/json-render --skill react -g -a claude-code -a codex -a antigravity -y",
                output,
            )
            self.assertIn(
                "npx skills add kepano/obsidian-skills --skill defuddle -g -a claude-code -a codex -a antigravity -y",
                output,
            )
            self.assertNotIn("--skill json-render", output)

    def test_skips_external_entries_missing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "skills.lock.json"
            lock_file.write_text(
                json.dumps(
                    {
                        "external": {
                            "broken": {},
                            "defuddle": {"source": "kepano/obsidian-skills"},
                        }
                    }
                )
            )
            output = subprocess.check_output(
                [sys.executable, str(RESTORE_LOCK), str(lock_file)],
                text=True,
                stderr=subprocess.STDOUT,
            )
            self.assertIn("npx skills add kepano/obsidian-skills", output)
            self.assertNotIn("--skill broken", output)

    def test_restore_dry_run_reads_selected_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog = root / "catalog"
            (catalog / "agents").mkdir(parents=True)
            (catalog / "agents/catalog-agent.md").write_text("catalog agent\n")
            (catalog / "skills.lock.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "custom": {"repo": "owner/catalog", "skills": {}},
                        "external": {
                            "external": {
                                "source": "owner/external",
                                "sourceUrl": "https://github.com/owner/external.git",
                                "skillPath": "skills/external/SKILL.md",
                            }
                        },
                        "vendor": {},
                    }
                )
            )
            env = os.environ.copy()
            env["HOME"] = str(root / "home")

            result = subprocess.run(
                [
                    "bash",
                    str(SKILLS_RESTORE),
                    "--catalog-dir",
                    str(catalog),
                    "--dry-run",
                ],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("npx skills add owner/external --skill external", result.stdout)
            self.assertIn("npx skills add owner/catalog --skill *", result.stdout)
            self.assertIn(str(catalog / "agents"), result.stdout)


class RegisterUnmanagedTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module(REGISTER_UNMANAGED, "register_unmanaged")

    def test_is_custom_skill_does_not_assume_missing_global_lock_is_custom(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            self.assertFalse(self.module.is_custom_skill("external-only", repo_root, {}, "owner/catalog"))

    def test_is_custom_skill_uses_catalog_repo_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            global_lock = {"catalog-skill": {"source": "owner/catalog"}}
            self.assertTrue(
                self.module.is_custom_skill(
                    "catalog-skill",
                    repo_root,
                    global_lock,
                    "owner/catalog",
                )
            )

    def test_build_custom_entry_returns_none_when_repo_source_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            entry = self.module.build_custom_entry("missing-skill", repo_root, {})
            self.assertIsNone(entry)

    def test_selected_catalog_precedes_legacy_repo_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog = root / "catalog"
            legacy = root / "legacy"
            catalog.mkdir()
            legacy.mkdir()
            with patch.dict(
                os.environ,
                {"MY_SKILLS_CATALOG_DIR": str(catalog), "REPO_ROOT": str(legacy)},
            ):
                selected = self.module.get_repo_root()

            self.assertEqual(selected, catalog.resolve())


class VendorForkIntegrationTests(unittest.TestCase):
    def test_selected_catalog_owns_vendor_and_upstream_copies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog = root / "catalog"
            catalog.mkdir()
            installed = root / "home" / ".agents" / "skills" / "catalog-vendor-fixture"
            installed.mkdir(parents=True)
            (installed / "SKILL.md").write_text("---\nname: catalog-vendor-fixture\n---\n")

            env = os.environ.copy()
            env["HOME"] = str(root / "home")
            result = subprocess.run(
                [
                    "bash",
                    str(VENDOR_FORK),
                    "--catalog-dir",
                    str(catalog),
                    "catalog-vendor-fixture",
                ],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((catalog / "vendor/catalog-vendor-fixture/SKILL.md").is_file())
            self.assertTrue((catalog / "upstream/catalog-vendor-fixture/SKILL.md").is_file())
            self.assertFalse((REPO_ROOT / "vendor/catalog-vendor-fixture").exists())

    def test_audit_reads_vendor_and_upstream_from_selected_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp) / "catalog"
            upstream = catalog / "upstream/catalog-audit-fixture"
            vendor = catalog / "vendor/catalog-audit-fixture"
            upstream.mkdir(parents=True)
            vendor.mkdir(parents=True)
            (upstream / "SKILL.md").write_text("upstream\n")
            (vendor / "SKILL.md").write_text("vendor\n")

            result = subprocess.run(
                ["bash", str(VENDOR_AUDIT), "--catalog-dir", str(catalog)],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("CHANGED: catalog-audit-fixture", result.stdout)

    def test_sync_updates_upstream_in_selected_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog = root / "catalog"
            vendor = catalog / "vendor/catalog-sync-fixture"
            upstream = catalog / "upstream/catalog-sync-fixture"
            vendor.mkdir(parents=True)
            upstream.mkdir(parents=True)
            (vendor / "SKILL.md").write_text("vendor\n")
            (upstream / "SKILL.md").write_text("old upstream\n")
            (catalog / "skills.lock.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "custom": {"repo": "owner/catalog", "skills": {}},
                        "external": {
                            "catalog-sync-fixture": {
                                "source": "owner/upstream",
                                "sourceUrl": "https://github.com/owner/upstream.git",
                                "skillPath": "skills/catalog-sync-fixture/SKILL.md",
                            }
                        },
                        "vendor": {},
                    }
                )
            )
            stub = root / "skills-stub"
            stub.write_text(
                "#!/bin/bash\n"
                "set -euo pipefail\n"
                'target="$HOME/.agents/skills/catalog-sync-fixture"\n'
                'mkdir -p "$target"\n'
                "printf 'new upstream\\n' > \"$target/SKILL.md\"\n"
            )
            stub.chmod(0o755)
            trash_stub = root / "trash-stub"
            trash_stub.write_text(
                '#!/bin/bash\nset -euo pipefail\nfor path in "$@"; do mv -- "$path" "$path.trashed"; done\n'
            )
            trash_stub.chmod(0o755)

            env = os.environ.copy()
            env["MY_SKILLS_ADD_BIN"] = str(stub)
            env["MY_SKILLS_TRASH_BIN"] = str(trash_stub)
            result = subprocess.run(
                ["bash", str(VENDOR_SYNC), "--catalog-dir", str(catalog)],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((upstream / "SKILL.md").read_text(), "new upstream\n")
            self.assertFalse((REPO_ROOT / "upstream/catalog-sync-fixture").exists())


class SkillsAddHelperCliTests(unittest.TestCase):
    """Keep the skills-add helper contracts language-independent."""

    def run_script(self, script: Path, *args: str, env: dict[str, str] | None = None):
        command_env = os.environ.copy()
        if env:
            command_env.update(env)
        return subprocess.run(
            [sys.executable, str(script), *args],
            capture_output=True,
            text=True,
            env=command_env,
            check=False,
        )

    def test_normalize_github_url_accepts_common_https_ssh_and_repo_forms(self):
        for url in (
            "https://github.com/owner/repo",
            "https://github.com/owner/repo.git/",
            "ssh://git@github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "owner/repo",
        ):
            with self.subTest(url=url):
                result = self.run_script(NORMALIZE_GITHUB_URL, url)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "owner/repo")

    def test_normalize_github_url_rejects_unparseable_input(self):
        result = self.run_script(NORMALIZE_GITHUB_URL, "not-a-repository")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Cannot parse GitHub URL", result.stderr)

    def test_resolve_skill_path_matches_skill_name_in_tree_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            tree_file = tmp_path / "tree.json"
            tree_file.write_text(
                json.dumps(
                    {
                        "tree": [
                            {"path": "README.md", "type": "blob"},
                            {"path": "packs/target/SKILL.md", "type": "blob"},
                        ]
                    }
                )
            )
            gh = tmp_path / "gh"
            self.write_gh_stub(gh, "target", "---\nname: target\ndescription: fixture\n---\n")

            result = self.run_script(
                RESOLVE_SKILL_PATH,
                env={
                    "TREE_FILE": str(tree_file),
                    "SKILL_NAME": "target",
                    "OWNER_REPO": "owner/repo",
                    "PATH": f"{tmp_path}:{os.environ['PATH']}",
                },
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "packs/target/SKILL.md")

    def test_resolve_skill_path_returns_empty_output_when_name_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            tree_file = tmp_path / "tree.json"
            tree_file.write_text(json.dumps({"tree": [{"path": "packs/other/SKILL.md", "type": "blob"}]}))
            gh = tmp_path / "gh"
            self.write_gh_stub(gh, "other", "---\nname: other\ndescription: fixture\n---\n")

            result = self.run_script(
                RESOLVE_SKILL_PATH,
                env={
                    "TREE_FILE": str(tree_file),
                    "SKILL_NAME": "missing",
                    "OWNER_REPO": "owner/repo",
                    "PATH": f"{tmp_path}:{os.environ['PATH']}",
                },
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_register_skill_lock_preserves_existing_sections_and_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "skills.lock.json"
            lock_file.write_text(
                json.dumps(
                    {
                        "version": 3,
                        "custom": {"skills": {"local": {"repoPath": "skills/local"}}},
                        "external": {"old": {"source": "old/repo"}},
                        "vendor": {"managed": {"source": "upstream/repo"}},
                    }
                )
            )

            result = self.run_script(
                REGISTER_SKILL_LOCK,
                str(lock_file),
                "new",
                "owner/repo",
                "https://github.com/owner/repo.git",
                "packs/new/SKILL.md",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            lock = json.loads(lock_file.read_text())
            self.assertEqual(lock["version"], 3)
            self.assertIn("local", lock["custom"]["skills"])
            self.assertEqual(lock["external"]["old"], {"source": "old/repo"})
            self.assertEqual(lock["vendor"]["managed"], {"source": "upstream/repo"})
            self.assertEqual(
                lock["external"]["new"],
                {
                    "source": "owner/repo",
                    "sourceUrl": "https://github.com/owner/repo.git",
                    "skillPath": "packs/new/SKILL.md",
                },
            )

    @staticmethod
    def write_gh_stub(path: Path, skill_name: str, content: str):
        encoded = base64.b64encode(content.encode()).decode()
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            "import sys\n"
            f"encoded = {encoded!r}\n"
            f"skill_name = {skill_name!r}\n"
            "endpoint = sys.argv[-1]\n"
            "if '/git/trees/' in endpoint:\n"
            "    print(json.dumps({'tree': [{'path': f'packs/{skill_name}/SKILL.md', 'type': 'blob'}]}))\n"
            "elif f'/contents/packs/{skill_name}/SKILL.md' in endpoint:\n"
            "    print(json.dumps({'content': encoded}))\n"
            "else:\n"
            "    raise SystemExit(1)\n"
        )
        path.chmod(0o755)


class SkillsAddIntegrationTests(unittest.TestCase):
    """Exercise the real bash orchestration while replacing only external commands."""

    def test_skills_add_filter_ignore_fallback_links_and_no_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = tmp_path / "repo"
            subprocess.run(
                ["git", "clone", "--quiet", "--no-hardlinks", str(REPO_ROOT), str(repo)],
                check=True,
                capture_output=True,
                text=True,
            )
            for relative_path in (
                ".agents/skills/skills-add/scripts/normalize-github-url.py",
                ".agents/skills/skills-add/scripts/resolve-skill-path.py",
                ".agents/skills/skills-add/scripts/register-skill-lock.py",
                ".agents/skills/skills-add/scripts/run-skills-cli.sh",
                ".agents/skills/skills-add/scripts/skills-add",
            ):
                source = REPO_ROOT / relative_path
                destination = repo / relative_path
                shutil.copy2(source, destination)
            catalog = tmp_path / "catalog"
            catalog.mkdir()
            lock_file = catalog / "skills.lock.json"
            lock_file.write_text(
                json.dumps(
                    {
                        "version": 3,
                        "custom": {"skills": {"local": {"repoPath": "skills/local"}}},
                        "external": {
                            "existing": {
                                "source": "old/repo",
                                "sourceUrl": "https://github.com/old/repo.git",
                                "skillPath": "skills/existing/SKILL.md",
                            }
                        },
                        "vendor": {"managed": {"source": "upstream/repo"}},
                    }
                )
            )
            (catalog / ".skills-ignore.json").write_text(json.dumps({"ignore": ["ignored"]}))

            home = tmp_path / "home"
            active = home / ".agents" / "skills"
            active.mkdir(parents=True)
            (active / "existing").mkdir()
            (active / "existing" / "SKILL.md").write_text("---\nname: existing\n---\n")
            claude = tmp_path / "claude-skills"
            gemini = tmp_path / "gemini-skills"

            bin_dir = tmp_path / "bin"
            bin_dir.mkdir()
            skills_stub = bin_dir / "skills-stub"
            skills_stub.write_text(
                "#!/usr/bin/env python3\n"
                "import os\n"
                "import sys\n"
                "from pathlib import Path\n"
                "names = [sys.argv[i + 1] for i, value in enumerate(sys.argv[:-1]) if value == '--skill']\n"
                "root = Path(os.environ['HOME']) / '.agents' / 'skills'\n"
                "for name in names:\n"
                "    skill = root / name\n"
                "    skill.mkdir(parents=True, exist_ok=True)\n"
                "    (skill / 'SKILL.md').write_text(f'---\\nname: {name}\\ndescription: fixture\\n---\\n')\n"
            )
            skills_stub.chmod(0o755)

            gh_stub = bin_dir / "gh"
            gh_stub.write_text(
                "#!/usr/bin/env python3\n"
                "import base64\n"
                "import json\n"
                "import sys\n"
                "endpoint = sys.argv[-1]\n"
                "if '/git/trees/' in endpoint:\n"
                "    print(json.dumps({'tree': [{'path': 'packs/alpha/SKILL.md', 'type': 'blob'}]}))\n"
                "elif endpoint.endswith('/contents/packs/alpha/SKILL.md'):\n"
                "    content = base64.b64encode(b'---\\nname: alpha\\ndescription: fixture\\n---\\n').decode()\n"
                "    print(json.dumps({'content': content}))\n"
                "else:\n"
                "    raise SystemExit(1)\n"
            )
            gh_stub.chmod(0o755)

            before_head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
            env = os.environ.copy()
            env.update(
                {
                    "HOME": str(home),
                    "PATH": f"{bin_dir}:{env['PATH']}",
                    "MY_SKILLS_ADD_BIN": str(skills_stub),
                    "MY_SKILLS_CATALOG_DIR": str(catalog),
                    "MY_SKILLS_ACTIVE_DIR": str(active),
                    "MY_SKILLS_CLAUDE_SKILLS_DIR": str(claude),
                    "MY_SKILLS_GEMINI_SKILLS_DIR": str(gemini),
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(repo / ".agents/skills/skills-add/scripts/skills-add"),
                    "git@github.com:owner/repo.git",
                    "--skill",
                    "alpha",
                    "--skill",
                    "ignored",
                    "--skill",
                    "existing",
                    "--skill",
                    "fallback",
                    "--no-commit",
                ],
                cwd=repo,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            lock = json.loads(lock_file.read_text())
            self.assertEqual(lock["version"], 3)
            self.assertIn("local", lock["custom"]["skills"])
            self.assertIn("managed", lock["vendor"])
            self.assertEqual(lock["external"]["existing"]["source"], "old/repo")
            self.assertEqual(lock["external"]["alpha"]["skillPath"], "packs/alpha/SKILL.md")
            self.assertEqual(lock["external"]["fallback"]["skillPath"], "skills/fallback/SKILL.md")
            self.assertNotIn("ignored", lock["external"])
            self.assertNotIn("beta", lock["external"])

            for agent_dir in (claude, gemini):
                self.assertTrue((agent_dir / "alpha").is_symlink())
                self.assertTrue((agent_dir / "fallback").is_symlink())
                self.assertEqual((agent_dir / "alpha").resolve(), (active / "alpha").resolve())
                self.assertEqual((agent_dir / "fallback").resolve(), (active / "fallback").resolve())

            after_head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
            self.assertEqual(after_head, before_head)
