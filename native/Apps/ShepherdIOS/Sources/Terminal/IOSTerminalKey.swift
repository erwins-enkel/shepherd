import ShepherdAppCore

/// Byte-for-byte parity with ui/src/lib/controlKeys.ts, including the pinned Enter.
enum IOSTerminalKey: CaseIterable {
    case escape, left, right, up, down, tab, space, ctrlA, ctrlE, ctrlU, ctrlC, ctrlD, enter

    var sequence: String {
        switch self {
        case .escape: "\u{1b}"
        case .left: "\u{1b}[D"
        case .right: "\u{1b}[C"
        case .up: "\u{1b}[A"
        case .down: "\u{1b}[B"
        case .tab: "\u{09}"
        case .space: " "
        case .ctrlA: "\u{01}"
        case .ctrlE: "\u{05}"
        case .ctrlU: "\u{15}"
        case .ctrlC: "\u{03}"
        case .ctrlD: "\u{04}"
        case .enter: "\u{0d}"
        }
    }
    /// Conventional keycaps, like the web palette; translated names are spoken by VoiceOver.
    var keycap: String {
        switch self {
        case .escape: "Esc"
        case .left: "←"
        case .right: "→"
        case .up: "↑"
        case .down: "↓"
        case .tab: "Tab"
        case .space: "␣"
        case .ctrlA: "^A"
        case .ctrlE: "^E"
        case .ctrlU: "^U"
        case .ctrlC: "^C"
        case .ctrlD: "^D"
        case .enter: "⏎"
        }
    }
    var accessibilityLabel: String {
        switch self {
        case .escape: L.t("controlkey_escape")
        case .left: L.t("controlkey_arrow_left")
        case .right: L.t("controlkey_arrow_right")
        case .up: L.t("controlkey_arrow_up")
        case .down: L.t("controlkey_arrow_down")
        case .tab: L.t("controlkey_tab")
        case .space: L.t("controlkey_space")
        case .ctrlA: L.t("controlkey_ctrl_a")
        case .ctrlE: L.t("controlkey_ctrl_e")
        case .ctrlU: L.t("controlkey_ctrl_u")
        case .ctrlC: L.t("controlkey_ctrl_c")
        case .ctrlD: L.t("controlkey_ctrl_d")
        case .enter: L.t("controlkey_enter")
        }
    }
}
