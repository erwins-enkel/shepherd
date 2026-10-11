import Foundation

/// Claude Code offers a follow-up prompt as dim (SGR 2) text on the empty input line, which Tab
/// accepts. Typed drafts and earlier prompts in the transcript are not dim, and the input line is
/// the last `❯` row with the box's bottom border right below it.
enum IOSTerminalSuggestion {
    struct Cell: Equatable {
        let character: Character
        let dim: Bool
    }

    /// The suggestion on screen, or nil. `cells` reads one row's cells; only the prompt row is read.
    static func text(_ rows: [String], cells: (Int) -> [Cell]) -> String? {
        guard let prompt = rows.lastIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("❯") }),
              let below = rows[(prompt + 1)...].first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
              below.trimmingCharacters(in: .whitespaces).hasPrefix("─") else { return nil }
        let row = cells(prompt)
        guard let caret = row.firstIndex(where: { $0.character == "❯" }) else { return nil }
        let rest = row[(caret + 1)...].drop { $0.character.isWhitespace }
        guard let last = rest.lastIndex(where: { !$0.character.isWhitespace }) else { return nil }
        let text = rest[...last]
        // The cursor sits on the first character and may repaint it without the dim attribute.
        let body = text.count > 1 ? text.dropFirst() : text
        guard body.allSatisfy({ $0.dim || $0.character.isWhitespace }) else { return nil }
        return String(text.map { $0.character })
    }

    /// Text typed into the input box but not yet sent, or nil; Enter submits it. The box's top
    /// border sits right above the caret row, and a long draft wraps onto indented rows before
    /// the bottom border. Only the first row is returned.
    static func draft(_ rows: [String], cells: (Int) -> [Cell]) -> String? {
        func border(_ row: String) -> Bool { row.trimmingCharacters(in: .whitespaces).hasPrefix("─") }
        guard let prompt = rows.lastIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("❯") }),
              prompt > 0, border(rows[prompt - 1]),
              let bottom = rows[(prompt + 1)...].firstIndex(where: border),
              rows[(prompt + 1)..<bottom].allSatisfy({ $0.first?.isWhitespace == true }) else { return nil }
        let row = cells(prompt)
        guard let caret = row.firstIndex(where: { $0.character == "❯" }) else { return nil }
        let rest = row[(caret + 1)...].drop { $0.character.isWhitespace }
        guard let last = rest.lastIndex(where: { !$0.character.isWhitespace }) else { return nil }
        let text = rest[...last]
        // Dim text is a suggestion or placeholder; the cursor may repaint its first character.
        let body = text.count > 1 ? text.dropFirst() : text
        guard !body.allSatisfy({ $0.dim || $0.character.isWhitespace }) else { return nil }
        return String(text.map { $0.character })
    }
}
