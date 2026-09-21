import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("publish_appcast", Path(__file__).with_name("publish-appcast.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def feed(version, extra=""):
    return (f'<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">'
            f'<channel><item><sparkle:version>{version}</sparkle:version>{extra}</item></channel></rss>').encode()


class FeedTransitionTests(unittest.TestCase):
    def test_initial_and_newer_publish(self):
        self.assertTrue(module.should_publish(None, feed(2)))
        self.assertTrue(module.should_publish(feed(2), feed(3)))

    def test_identical_retry_is_noop(self):
        self.assertFalse(module.should_publish(feed(2), feed(2)))

    def test_rollback_and_changed_same_build_are_rejected(self):
        for incoming in [feed(1), feed(2, "<title>different archive</title>")]:
            with self.assertRaises(ValueError):
                module.should_publish(feed(2), incoming)

    def test_invalid_feed_is_rejected_before_first_publication(self):
        for incoming in [b"<rss/>", feed("invalid"), b"not xml"]:
            with self.assertRaises((ValueError, module.ET.ParseError)):
                module.should_publish(None, incoming)


if __name__ == "__main__":
    unittest.main()
