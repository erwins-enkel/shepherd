import Foundation
import Testing
@testable import ShepherdAppCore

// Same case table as ui/src/lib/textLinks.test.ts — keep them in step.
extension CoreSeamTests {
struct TextLinksTests {
    private func hrefs(_ text: String) -> [String] { TextLinks.segments(text).compactMap(\.href) }

    @Test func linksABareURLInsideProse() {
        let url = "https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK"
        let text = "Drei Varianten ganz oben auf \(url) (Version 3). Welche nehmen wir?"
        #expect(TextLinks.segments(text) == [
            .init(text: "Drei Varianten ganz oben auf ", href: nil),
            .init(text: url, href: url),
            .init(text: " (Version 3). Welche nehmen wir?", href: nil),
        ])
    }

    @Test func leavesTrailingPunctuationAndQuotesOutOfTheLink() {
        #expect(hrefs("See https://x.dev/a.") == ["https://x.dev/a"])
        #expect(hrefs("„https://x.dev/a“") == ["https://x.dev/a"])
        #expect(hrefs("\"https://x.dev/a\",") == ["https://x.dev/a"])
        #expect(hrefs("https://x.dev/a?!") == ["https://x.dev/a"])
    }

    @Test func dropsAnUnbalancedClosingBracketButKeepsABalancedOne() {
        #expect(hrefs("(https://x.dev/a)") == ["https://x.dev/a"])
        #expect(hrefs("[https://x.dev/a]") == ["https://x.dev/a"])
        #expect(hrefs("https://en.wikipedia.org/wiki/Foo_(bar)") == ["https://en.wikipedia.org/wiki/Foo_(bar)"])
        #expect(hrefs("(see https://en.wikipedia.org/wiki/Foo_(bar)).") == ["https://en.wikipedia.org/wiki/Foo_(bar)"])
    }

    @Test func linksEveryURLInTheText() {
        #expect(hrefs("http://a.dev/x and https://b.dev/y") == ["http://a.dev/x", "https://b.dev/y"])
    }

    @Test func matchesTheSchemeCaseInsensitivelyKeepingTheURLAsWritten() {
        #expect(hrefs("HTTPS://X.DEV/A") == ["HTTPS://X.DEV/A"])
    }

    @Test func linksNothingThatIsNotABareHTTPURL() {
        for text in ["No link here.", "www.example.com", "ftp://x.dev/a", "javascript:alert(1)",
                     "https://", "https://.", "xhttps://a.b", ""] {
            #expect(hrefs(text).isEmpty, "\(text)")
        }
    }

    @Test func alwaysReassemblesToTheInput() {
        for text in ["Drei Varianten auf https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK (Version 3).",
                     "(see https://en.wikipedia.org/wiki/Foo_(bar)).", "„https://x.dev/a“ and http://b.dev",
                     "No link here.", ""] {
            #expect(TextLinks.segments(text).map(\.text).joined() == text)
        }
    }

    @Test func attributedLinksOnlyTheURL() {
        let text = "See https://x.dev/a."
        let attributed = TextLinks.attributed(text)
        #expect(String(attributed.characters) == text)
        let links = attributed.runs.compactMap { run in
            run.link.map { ($0, String(attributed[run.range].characters)) }
        }
        #expect(links.count == 1)
        #expect(links.first?.0 == URL(string: "https://x.dev/a"))
        #expect(links.first?.1 == "https://x.dev/a")
    }
}
}
