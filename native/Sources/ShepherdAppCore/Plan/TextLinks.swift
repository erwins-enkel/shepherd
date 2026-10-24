import Foundation

/// Bare http(s) URLs in plain text as links — an agent's question names an artifact or PR the
/// operator wants to open, not copy. Same rule and cases as ui/src/lib/textLinks.ts.
public enum TextLinks {
    struct Segment: Equatable {
        let text: String
        /// Set on a link segment: the URL, exactly as written in the text.
        let href: String?
    }

    // A scheme at a word start, then everything up to whitespace or a char that can't sit in a bare URL.
    private static let pattern = #"(?<![\p{L}\p{N}_])https?://[^\s<>"`]+"#
    // Sentence punctuation and quotes after a URL belong to the prose, not the link.
    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", "'", "\"", "…", "“", "”", "‘", "’", "»", "«"]
    private static let opener: [Character: Character] = [")": "(", "]": "[", "}": "{"]

    /// `text` with a `link` attribute on each bare http(s) URL; SwiftUI `Text` makes those tappable.
    public static func attributed(_ text: String) -> AttributedString {
        var result = AttributedString()
        for segment in segments(text) {
            var part = AttributedString(segment.text)
            if let href = segment.href { part.link = URL(string: href) }
            result.append(part)
        }
        return result
    }

    /// `text` as an ordered run of plain and link segments; their texts join back to `text`.
    static func segments(_ text: String) -> [Segment] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
            return text.isEmpty ? [] : [Segment(text: text, href: nil)]
        }
        var segments: [Segment] = []
        var at = text.startIndex
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text) else { continue }
            let url = trimTrailing(text[range])
            guard let scheme = url.range(of: "://"), scheme.upperBound < url.endIndex else { continue }
            if range.lowerBound > at { segments.append(Segment(text: String(text[at..<range.lowerBound]), href: nil)) }
            segments.append(Segment(text: String(url), href: String(url)))
            at = url.endIndex
        }
        if at < text.endIndex { segments.append(Segment(text: String(text[at...]), href: nil)) }
        return segments
    }

    /// Drop trailing punctuation, and a closing bracket the URL never opened (`(https://x.dev)`).
    private static func trimTrailing(_ url: Substring) -> Substring {
        var url = url
        while let last = url.last {
            let unopened = opener[last].map { open in
                url.filter { $0 == last }.count > url.filter { $0 == open }.count
            } ?? false
            guard trailing.contains(last) || unopened else { break }
            url = url.dropLast()
        }
        return url
    }
}
