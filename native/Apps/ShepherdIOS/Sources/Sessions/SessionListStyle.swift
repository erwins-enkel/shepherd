import SwiftUI

/// DESIGN.md's dark terminal palette. The list uses the product's default dark theme.
enum SessionListStyle {
    static let background = color(0x0a0d0c)
    static let panel = color(0x0f1413)
    static let selected = color(0x18211e)
    static let line = color(0x1b2422)
    static let brightLine = color(0x2c3835)
    static let ink = color(0xc4d0cb)
    static let bright = color(0xeef4f0)
    static let muted = color(0x7c8c86)
    static let amber = color(0xe8a13a)
    static let green = color(0x5ad19a)
    static let red = color(0xe5484d)
    static let blue = color(0x4a90d9)
    static let slate = color(0x566460)

    static func badgeTint(_ tint: Color) -> Color {
        switch tint {
        case .green: green
        case .red: red
        case .orange, .yellow: amber
        case .blue: blue
        case .primary: bright
        case .secondary.opacity(0.25): muted.opacity(0.25)
        default: muted
        }
    }

    private static func color(_ rgb: UInt32) -> Color {
        Color(red: Double((rgb >> 16) & 255) / 255,
            green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
}

/// Exact design rungs at default size, uncapped Dynamic Type at larger settings.
struct SessionMonoFont: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var bodySize = 13.0
    @ScaledMetric(relativeTo: .caption) private var labelSize = 11.0
    var label = false
    var weight: Font.Weight = .regular
    func body(content: Content) -> some View {
        content.font(.system(size: label ? labelSize : bodySize, weight: weight, design: .monospaced))
    }
}

extension View {
    func sessionFont(label: Bool = false, weight: Font.Weight = .regular) -> some View {
        modifier(SessionMonoFont(label: label, weight: weight))
    }
}
