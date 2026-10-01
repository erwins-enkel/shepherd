import SwiftUI

/// Approved compose-canvas tokens. Native chrome uses the same terminal hierarchy.
enum ComposePalette {
    static let bg = color(0x0a0d0c), panel = color(0x111614), panel2 = color(0x161d1a)
    static let line = color(0x24302c), ink = color(0xc4d0cb), bright = color(0xe8f0eb)
    static let muted = color(0x8a9a93), faint = color(0x62716b)
    static let amber = color(0xe8a13a), red = color(0xe5484d), green = color(0x5ad19a), slate = color(0x566460)
    static func color(_ hex: UInt32) -> Color { Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255) }
}
struct ComposeControlStyle: ButtonStyle {
    var accent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.padding(.horizontal, 12).frame(minHeight: 44)
            .foregroundStyle(accent ? ComposePalette.amber : ComposePalette.ink)
            .background(configuration.isPressed ? ComposePalette.panel2 : ComposePalette.panel)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ComposePalette.line))
    }
}

private struct ComposeRenderingKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var composeRendering: Bool {
        get { self[ComposeRenderingKey.self] }
        set { self[ComposeRenderingKey.self] = newValue }
    }
}
