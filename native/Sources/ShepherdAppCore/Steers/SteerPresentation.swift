import Foundation
import ShepherdKit

extension ComposeSteer {
    public var chipTitle: String {
        [emoji, label].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " ")
    }
}

/// Positions belong to the scoped bar, never to the current search results.
public enum SteerShortcuts {
    public static func number(for id: String, in steers: [ComposeSteer]) -> Int? {
        guard let index = steers.firstIndex(where: { $0.id == id }), index < 9 else { return nil }
        return index + 1
    }

    public static func matches(_ steers: [ComposeSteer], search: String) -> [ComposeSteer] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return steers }
        return steers.filter {
            $0.chipTitle.localizedStandardContains(query) || $0.text.localizedStandardContains(query)
        }
    }
}
