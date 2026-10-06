import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
import tempfile
import json
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mac_dev_preflight", Path(__file__).with_name("mac-dev-preflight.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

DETACH_PROBE = module.detaches_on_quit

SESSIONS = [("TASK-01", "running", "demo", "term_1")]


def verdict(apps, server, procs, sessions=SESSIONS, terminals=frozenset({"term_1"}), herdr=(9,), detaches=False):
    """Runs main() against a faked process table; returns (exit code, last output line)."""
    module.detaches_on_quit = lambda server, apps: detaches
    module.pids = lambda pattern: list(apps) if "Shepherd" in pattern else list(herdr)
    module.listener = lambda port: server
    module.proc = lambda pid: procs.get(pid)
    module.database_path = lambda: "/unused.db"
    module.active_sessions = lambda db: sessions
    module.herdr_terminals = lambda: None if terminals is None else set(terminals)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = module.main()
    return code, out.getvalue().strip().splitlines()[-1]


class PreflightTests(unittest.TestCase):
    def test_detaching_build_does_not_need_session_or_herdr_checks(self):
        code, last = verdict([100], 200, {200: (100, 200)}, terminals=None, detaches=True)
        self.assertEqual(code, 0)
        self.assertIn("sessions continue", last)

    def test_capability_requires_a_live_record_for_the_running_listener(self):
        with tempfile.TemporaryDirectory() as home, patch.object(Path, "home", return_value=Path(home)):
            directory = Path(home) / ".shepherd/run"
            directory.mkdir(parents=True)
            record = directory / "app-server-7330-test.json"
            module.proc = lambda pid: {200: (100, 200), 300: (100, 300)}.get(pid)
            self.assertFalse(DETACH_PROBE(200, [100]))
            record.write_text(json.dumps({"pid": 300, "processGroup": 300, "port": 7330}))
            self.assertFalse(DETACH_PROBE(200, [100]))
            record.write_text(json.dumps({"pid": 200, "processGroup": 200, "port": 7330}))
            self.assertTrue(DETACH_PROBE(200, [100]))
            self.assertFalse(DETACH_PROBE(200, [999]))
            module.proc = lambda pid: None
            self.assertFalse(DETACH_PROBE(200, [100]))

    def test_nothing_running_is_safe(self):
        self.assertEqual(verdict([], None, {})[0], 0)

    def test_server_the_app_did_not_start_is_untouched(self):
        self.assertEqual(verdict([100], 200, {200: (1, 200)})[0], 0)

    def test_supervised_server_without_sessions_is_safe(self):
        self.assertEqual(verdict([100], 200, {200: (100, 200)}, sessions=[])[0], 0)

    def test_independent_herdr_means_interruption(self):
        code, last = verdict([100], 200, {200: (100, 200), 9: (1, 9)})
        self.assertEqual(code, 2)
        self.assertIn("--yes", last)

    def test_herdr_in_the_server_group_means_loss(self):
        self.assertEqual(verdict([100], 200, {200: (100, 200), 9: (200, 200)})[0], 3)

    def test_herdr_started_by_the_app_means_loss(self):
        self.assertEqual(verdict([100], 200, {200: (100, 200), 9: (100, 9)})[0], 3)

    def test_unanswering_herdr_is_treated_as_loss(self):
        code, last = verdict([100], 200, {200: (100, 200), 9: (1, 9)}, terminals=None)
        self.assertEqual(code, 3)
        self.assertIn("--force", last)


if __name__ == "__main__":
    unittest.main()
