import Foundation

public enum EpicText {
    /// The parent title without a leading "Epic:" — the EPIC badge already says it.
    public static func displayTitle(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard trimmed.lowercased().hasPrefix("epic:") else { return trimmed }
        let rest = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? trimmed : rest
    }

    /// A child's title without a redundant parent prefix ("Stack-Angleichung (#158): …"): the
    /// segment before the first ": " goes only when it names the parent's number (the web's
    /// `stepTitle`).
    public static func stepTitle(_ title: String, parent: Int) -> String {
        guard let colon = title.range(of: ": ") else { return title }
        let head = title[..<colon.lowerBound]
        let tag = "#\(parent)"
        var search = head.startIndex..<head.endIndex
        while let hit = head.range(of: tag, range: search) {
            if hit.upperBound == head.endIndex || !head[hit.upperBound].isNumber {
                return String(title[colon.upperBound...])
            }
            search = hit.upperBound..<head.endIndex
        }
        return title
    }

    /// "#102 · #103": at most two numbers, then "+k".
    public static func numbers(_ list: [Int], prefix: String = "") -> String {
        let shown = list.prefix(2).map { "\(prefix)#\($0)" }.joined(separator: " · ")
        return list.count > 2 ? "\(shown) +\(list.count - 2)" : shown
    }
}
