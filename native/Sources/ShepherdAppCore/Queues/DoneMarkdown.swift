import Foundation
import Observation
import ShepherdKit
import SwiftUI

public enum DoneMarkdown {
    public static func render(_ markdown: String) -> AttributedString {
        guard let parsed = try? AttributedString(markdown: markdown) else {
            return AttributedString(markdown)
        }
        var result = AttributedString()
        // Foundation records block boundaries as presentation intents, removing their
        // newlines. Text handles inline emphasis/links, but needs explicit block separators.
        for (intent, range) in parsed.runs[\.presentationIntent] {
            if !result.characters.isEmpty { result.append(AttributedString("\n\n")) }
            var block = AttributedString(parsed[range])
            let components = intent?.components ?? []
            for component in components {
                switch component.kind {
                case .header: block.font = .headline
                case .codeBlock: block.font = .body.monospaced()
                case .listItem(let ordinal):
                    let unordered = components.contains { $0.kind == .unorderedList }
                    result.append(AttributedString(unordered ? "• " : "\(ordinal). "))
                default: break
                }
            }
            result.append(block)
        }
        return result
    }
}
