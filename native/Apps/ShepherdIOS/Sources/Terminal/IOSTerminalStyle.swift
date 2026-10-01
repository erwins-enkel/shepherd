import SwiftUI
import UIKit

/// The terminal/detail palette from DESIGN.md, scoped to this surface.
enum IOSTerminalStyle {
    static let background = Color(uiColor: nativeBackground)
    static let panel = Color(red: 15 / 255, green: 20 / 255, blue: 19 / 255)
    static let line = Color(red: 27 / 255, green: 36 / 255, blue: 34 / 255)
    static let ink = Color(uiColor: nativeInk)
    static let muted = Color(red: 124 / 255, green: 140 / 255, blue: 134 / 255)
    static let amber = Color(red: 232 / 255, green: 161 / 255, blue: 58 / 255)
    static let nativeBackground = UIColor(red: 10 / 255, green: 13 / 255, blue: 12 / 255, alpha: 1)
    static let nativeInk = UIColor(red: 196 / 255, green: 208 / 255, blue: 203 / 255, alpha: 1)
}
