import SwiftUI

/// Mirrors ui/src/lib/keymap/newTask.ts. The registry drives dispatch and every displayed cap.
public enum ComposeKeymap {
    public struct Chord: Hashable, Sendable {
        let key: String
        public let modifiers: EventModifiers
        init(_ key: String, _ modifiers: EventModifiers = []) { self.key = key; self.modifiers = modifiers }
        public func hash(into hasher: inout Hasher) { hasher.combine(key); hasher.combine(modifiers.rawValue) }
        public var equivalent: KeyEquivalent { key == "return" ? .return : key == "escape" ? .escape : KeyEquivalent(key.first!) }
        var cap: String {
            (modifiers.contains(.command) ? "⌘" : "") + (modifiers.contains(.option) ? "⌥" : "")
                + (key == "return" ? "↵" : key == "escape" ? "⎋" : key.uppercased())
        }
    }
    public struct Entry: Identifiable, Sendable {
        public let id: String
        public let label: StaticString
        public let chord: Chord?
        let literal: String?
        init(_ id: String, _ label: StaticString, _ chord: Chord? = nil, literal: String? = nil) {
            self.id = id; self.label = label; self.chord = chord; self.literal = literal
        }
        public var cap: String { literal ?? chord?.cap ?? "" }
    }
    public static let entries: [Entry] = [
        // ⌘↵ must not compete with Return's default action in the hold-likely pair.
        .init("submit", "keymap_submit", .init("return", .command)),
        .init("close", "keymap_close", .init("escape")),
        .init("hold", "keymap_hold", literal: "⌘"),
        // '?' is help only outside text fields. Text entry must keep its punctuation.
        .init("sheet", "keymap_sheet", .init("?")),
        .init("focus-prompt", "keymap_focus_prompt", .init("p", .command)),
        .init("issue-token", "keymap_issue_token", literal: "#"),
        .init("command-token", "keymap_command_token", literal: "/"),
        .init("paste-image", "keymap_paste_image", .init("v", .command)),
        .init("attach", "keymap_attach", .init("u", .command)),
        .init("dictate", "keymap_dictate", .init("d", .command)),
        .init("repo", "keymap_repo", .init("r", .option)),
        .init("branch", "keymap_branch", .init("b", .option)),
        .init("repo-prev", "keymap_repo_prev", .init("[", .option)),
        .init("repo-next", "keymap_repo_next", .init("]", .option)),
        .init("issue-filter", "keymap_issue_filter", .init("f", .command)),
        .init("sources-tab", "keymap_sources_tab", .init("t", .option)),
        .init("list-nav", "keymap_list_nav", literal: "↑↓"),
        .init("list-pick", "keymap_list_pick", literal: "↵"),
        .init("mode-code", "keymap_mode_code", .init("1", .option)),
        .init("mode-research", "keymap_mode_research", .init("2", .option)),
        .init("mode-epic", "keymap_mode_epic", .init("3", .option)),
        .init("mode-plain", "keymap_mode_plain", .init("4", .option)),
        .init("engine", "keymap_engine", .init("e", .command)),
        // ⌘M minimises a macOS window. The web deliberately uses ⌥M.
        .init("model", "keymap_model", .init("m", .option)),
        .init("plan-gate", "keymap_plan_gate", .init("g", .command)),
        // ⌘⇧A is Chrome's tab search; keep the web's ⌥A for parity.
        .init("autopilot", "keymap_autopilot", .init("a", .option))
    ]
    public static func entry(_ id: String) -> Entry { entries.first { $0.id == id }! }
    public static func canDispatch(_ id: String, editingText: Bool) -> Bool {
        // Dictation is explicitly deferred. These other rows document native/list behaviour.
        if ["dictate", "paste-image", "hold", "list-nav", "list-pick", "close"].contains(id) { return false }
        return id != "sheet" || !editingText
    }
}
