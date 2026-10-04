import contextlib
import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("mac_dev_preflight", Path(__file__).with_name("mac-dev-preflight.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SESSIONS = [("TASK-01", "running", "demo", "term_1")]


def verdict(apps, server, procs, sessions=SESSIONS, terminals=frozenset({"term_1"}), herdr=(9,)):
    """Runs main() against a faked process table; returns (exit code, last output line)."""
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
