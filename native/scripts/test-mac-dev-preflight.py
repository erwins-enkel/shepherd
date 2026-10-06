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
    """Historical session/group fixtures now all permit an app relaunch."""
    module.pids = lambda pattern: list(apps) if "Shepherd" in pattern else list(herdr)
    module.listener = lambda port: server
    # Relaunch no longer needs process ancestry, SQLite or herdr access.
    module.run = lambda *argv: (_ for _ in ()).throw(AssertionError("unexpected process probe"))
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

    def test_independent_herdr_continues_on_quit(self):
        code, last = verdict([100], 200, {200: (100, 200), 9: (1, 9)})
        self.assertEqual(code, 0)
        self.assertIn("sessions continue", last)

    def test_server_group_is_not_signalled_on_quit(self):
        self.assertEqual(verdict([100], 200, {200: (100, 200), 9: (200, 200)})[0], 0)

    def test_quit_does_not_signal_app_children(self):
        self.assertEqual(verdict([100], 200, {200: (100, 200), 9: (100, 9)})[0], 0)

    def test_relaunch_does_not_require_a_herdr_probe(self):
        code, last = verdict([100], 200, {200: (100, 200), 9: (1, 9)}, terminals=None)
        self.assertEqual(code, 0)
        self.assertIn("sessions continue", last)


if __name__ == "__main__":
    unittest.main()
