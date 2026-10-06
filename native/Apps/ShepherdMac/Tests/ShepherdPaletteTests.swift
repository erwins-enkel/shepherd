import AppKit
import SwiftUI
import XCTest
@testable import Shepherd

@MainActor
final class ShepherdPaletteTests: XCTestCase {
    func testAppearanceMatchesWebPalette() {
        let samples: [(Color, UInt32, UInt32)] = [
            (ShepherdPalette.bg, 0x0a0d0c, 0xe7ebe9),
            (ShepherdPalette.panel, 0x0f1413, 0xf7f9f8),
            (ShepherdPalette.amber, 0xe8a13a, 0xa8680a)
        ]
        for (name, dark) in [(NSAppearance.Name.darkAqua, true), (.aqua, false)] {
            let appearance = NSAppearance(named: name)!
            appearance.performAsCurrentDrawingAppearance {
                for (color, darkHex, lightHex) in samples {
                    let resolved = NSColor(color).usingColorSpace(.sRGB)!
                    let expected = dark ? darkHex : lightHex
                    XCTAssertEqual(resolved.redComponent, CGFloat((expected >> 16) & 255) / 255, accuracy: 0.001)
                    XCTAssertEqual(resolved.greenComponent, CGFloat((expected >> 8) & 255) / 255, accuracy: 0.001)
                    XCTAssertEqual(resolved.blueComponent, CGFloat(expected & 255) / 255, accuracy: 0.001)
                }
            }
        }
    }
}
