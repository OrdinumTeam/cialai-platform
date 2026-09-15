#!/usr/bin/env python3

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
HOOK = ROOT / "claude-statusline.py"
INSTALLER = ROOT / "install-claude-statusline.py"


def payload(session="s1", used=7.0):
    return {
        "session_id": session,
        "cwd": "/Users/example/project",
        "model": {"id": "claude-test", "display_name": "Modelo teste"},
        "rate_limits": {
            "five_hour": {"used_percentage": used, "resets_at": 1788916800},
            "seven_day": {"used_percentage": 26, "window_minutes": 10080},
        },
    }


class StatuslineTest(unittest.TestCase):
    def test_publishes_each_profile_and_merges_sessions(self):
        with tempfile.TemporaryDirectory(prefix="cialai-statusline-") as support:
            env = dict(os.environ, CIALAI_APP_SUPPORT=support, CLAUDE_CONFIG_DIR="~/.claude-work", CLAUDE_PROFILE="Trabalho")
            for session, used in (("a", 7), ("b", 12), ("a", 19)):
                result = subprocess.run(
                    [sys.executable, HOOK],
                    input=json.dumps(payload(session, used)),
                    text=True,
                    capture_output=True,
                    check=True,
                    env=env,
                )
            record = json.loads((pathlib.Path(support) / "ai-usage/claude/claude-work.json").read_text(encoding="utf-8"))
            self.assertEqual(record["profileName"], "Trabalho")
            self.assertEqual(record["windows"][0]["usedPercent"], 19)
            self.assertEqual(sorted(item["sessionId"] for item in record["sessions"]), ["a", "b"])
            self.assertIn("sessão 19%", result.stdout)

    def test_publishes_effort_context_and_cost_of_the_session(self):
        with tempfile.TemporaryDirectory(prefix="cialai-statusline-") as support:
            env = dict(os.environ, CIALAI_APP_SUPPORT=support, CLAUDE_CONFIG_DIR="~/.claude")
            rich = payload("s9", 3)
            rich["effort"] = {"level": "max"}
            rich["context_window"] = {"context_window_size": 200000, "used_percentage": 42.4, "remaining_percentage": 57.6}
            rich["cost"] = {"total_cost_usd": 1.8349, "total_duration_ms": 45000}
            result = subprocess.run(
                [sys.executable, HOOK], input=json.dumps(rich), text=True, capture_output=True, check=True, env=env,
            )
            record = json.loads((pathlib.Path(support) / "ai-usage/claude/claude.json").read_text(encoding="utf-8"))
            self.assertEqual(record["format"], 3)
            session = record["sessions"][0]
            self.assertEqual(session["effort"], "max")
            self.assertEqual(session["contextUsedPercent"], 42.4)
            self.assertEqual(session["contextWindowSize"], 200000)
            self.assertEqual(session["costUsd"], 1.8349)
            self.assertIn("max", result.stdout)
            self.assertIn("ctx 42%", result.stdout)
            # Sem used_percentage o percentual sai dos tokens de entrada.
            derived = payload("s10", 3)
            derived["context_window"] = {"context_window_size": 200000, "current_usage": {"input_tokens": 8500, "output_tokens": 1200, "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 2000}}
            subprocess.run([sys.executable, HOOK], input=json.dumps(derived), text=True, capture_output=True, check=True, env=env)
            record = json.loads((pathlib.Path(support) / "ai-usage/claude/claude.json").read_text(encoding="utf-8"))
            self.assertEqual(record["sessions"][0]["contextUsedPercent"], 7.8)
            self.assertNotIn("effort", record["sessions"][0])
            self.assertNotIn("costUsd", record["sessions"][0])

    def test_garbage_is_silent(self):
        with tempfile.TemporaryDirectory(prefix="cialai-statusline-") as support:
            result = subprocess.run(
                [sys.executable, HOOK],
                input="invalid",
                text=True,
                capture_output=True,
                check=True,
                env=dict(os.environ, CIALAI_APP_SUPPORT=support),
            )
            self.assertEqual(result.stdout, "")
            self.assertFalse((pathlib.Path(support) / "ai-usage").exists())

    def test_installer_backs_up_and_writes_both_command_forms(self):
        for platform in ("posix", "windows"):
            with tempfile.TemporaryDirectory(prefix="cialai-home-") as raw_home:
                home = pathlib.Path(raw_home)
                profile = home / ".claude-test"
                profile.mkdir()
                settings = profile / "settings.json"
                settings.write_text('{"theme":"dark"}\n', encoding="utf-8")
                subprocess.run(
                    [sys.executable, INSTALLER, "--home", home, "--platform", platform],
                    text=True,
                    capture_output=True,
                    check=True,
                )
                data = json.loads(settings.read_text(encoding="utf-8"))
                command = data["statusLine"]["command"]
                self.assertIn(".cialai", command)
                self.assertEqual(command.startswith("python \""), platform == "windows")
                self.assertEqual(len(list(profile.glob("settings.json.bak-*"))), 1)
                if platform == "posix":
                    self.assertNotEqual((home / ".cialai/claude-statusline.py").stat().st_mode & 0o111, 0)

    def test_installer_preserves_custom_hook_without_force(self):
        with tempfile.TemporaryDirectory(prefix="cialai-home-") as raw_home:
            home = pathlib.Path(raw_home)
            profile = home / ".claude"
            profile.mkdir()
            settings = profile / "settings.json"
            original = {"statusLine": {"type": "command", "command": "meu-hook"}}
            settings.write_text(json.dumps(original), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, INSTALLER, "--home", home],
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(json.loads(settings.read_text(encoding="utf-8")), original)
            self.assertIn("statusLine próprio mantido", result.stdout)
            self.assertEqual(list(profile.glob("settings.json.bak-*")), [])

    def test_installer_dry_run_does_not_touch_home(self):
        with tempfile.TemporaryDirectory(prefix="cialai-home-") as raw_home:
            home = pathlib.Path(raw_home)
            profile = home / ".claude"
            profile.mkdir()
            settings = profile / "settings.json"
            settings.write_text('{"theme":"dark"}\n', encoding="utf-8")
            before = settings.read_bytes()
            subprocess.run(
                [sys.executable, INSTALLER, "--home", home, "--dry-run"],
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(settings.read_bytes(), before)
            self.assertFalse((home / ".cialai").exists())
            self.assertEqual(list(profile.glob("settings.json.bak-*")), [])

    def test_windows_installer_keeps_the_selected_python_launcher(self):
        with tempfile.TemporaryDirectory(prefix="cialai-home-") as raw_home:
            home = pathlib.Path(raw_home)
            profile = home / ".claude"
            profile.mkdir()
            settings = profile / "settings.json"
            settings.write_text("{}\n", encoding="utf-8")
            subprocess.run(
                [
                    sys.executable,
                    INSTALLER,
                    "--home",
                    home,
                    "--platform",
                    "windows",
                    "--python-command",
                    "py -3",
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            data = json.loads(settings.read_text(encoding="utf-8"))
            self.assertTrue(data["statusLine"]["command"].startswith('py -3 "'))


if __name__ == "__main__":
    unittest.main()
