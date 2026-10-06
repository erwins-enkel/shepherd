import AppKit
import ShepherdKit
import SwiftUI

/// Mirrors app.css. Dynamic NSColors follow Settings Appearance as well as the system.
enum ShepherdPalette {
    static let bg = Color(nsColor: adaptive(dark: 0x0a0d0c, light: 0xe7ebe9))
    static let panel = Color(nsColor: adaptive(dark: 0x0f1413, light: 0xf7f9f8))
    static let panel2 = Color(nsColor: adaptive(dark: 0x0c100f, light: 0xeef1ef))
    static let sel = Color(nsColor: adaptive(dark: 0x18211e, light: 0xd2dbd6))
    static let line = Color(nsColor: adaptive(dark: 0x1b2422, light: 0xd2dad6))
    static let lineBright = Color(nsColor: adaptive(dark: 0x2c3835, light: 0xb9c4bf))
    static let ink = Color(nsColor: adaptive(dark: 0xc4d0cb, light: 0x2b3633))
    static let inkBright = Color(nsColor: adaptive(dark: 0xeef4f0, light: 0x131a18))
    static let muted = Color(nsColor: adaptive(dark: 0x7c8c86, light: 0x5a6862))
    static let faint = Color(nsColor: adaptive(dark: 0x4a5752, light: 0x93a09a))
    static let amber = Color(nsColor: adaptive(dark: 0xe8a13a, light: 0xa8680a))
    static let green = Color(nsColor: adaptive(dark: 0x5ad19a, light: 0x1d8a5d))
    static let red = Color(nsColor: adaptive(dark: 0xe5484d, light: 0xc2363b))
    static let blue = Color(nsColor: adaptive(dark: 0x4a90d9, light: 0x2f6fb0))
    static let slate = Color(nsColor: adaptive(dark: 0x566460, light: 0x6b7873))
    static let warn = Color(nsColor: adaptive(dark: 0xe8730c, light: 0xb5560a))

    static func adaptive(dark: UInt32, light: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255,
                green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
        }
    }

    static func statusTint(_ status: SessionStatus) -> Color {
        switch status.known {
        // app.css --status-*: running amber, blocked red; done (WARTET), idle and archived slate.
        case .running: amber
        case .blocked: red
        case .idle, .done, .archived: slate
        case nil: status.rawValue == "error" ? red : slate
        }
    }

    /// Translate shared presentation tints without changing the iOS/core contract.
    static func badgeTint(_ tint: Color) -> Color {
        switch tint {
        case .green: green
        case .red: red
        case .orange, .yellow: amber
        case .blue, .purple: blue
        case .primary: inkBright
        case .secondary.opacity(0.25): muted.opacity(0.25)
        default: ink
        }
    }

    static func badgeStroke(_ tint: Color) -> Color {
        switch tint {
        case .secondary, .primary, .gray: lineBright
        default: badgeTint(tint)
        }
    }
}

struct ShepherdMonoFont: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var bodySize = 13.0
    @ScaledMetric(relativeTo: .caption) private var labelSize = 11.0
    var label = false
    var weight: Font.Weight = .regular
    func body(content: Content) -> some View {
        content.font(.system(size: label ? labelSize : bodySize, weight: weight, design: .monospaced))
    }
}

struct ShepherdSidebarButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var primary = false
    /// Footer size: fills its share of the row at a 30 pt control height.
    var footer = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(ShepherdMonoFont(label: true, weight: .semibold))
            .lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, footer ? 0 : 5)
            .frame(maxWidth: footer ? .infinity : nil, minHeight: footer ? 30 : nil)
            .contentShape(Rectangle())
            .foregroundStyle(primary ? ShepherdPalette.bg : ShepherdPalette.ink)
            .background(primary ? ShepherdPalette.amber : ShepherdPalette.panel2,
                in: RoundedRectangle(cornerRadius: 4))
            .overlay { RoundedRectangle(cornerRadius: 4)
                .stroke(primary ? ShepherdPalette.amber : ShepherdPalette.line, lineWidth: 1) }
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
    }
}
