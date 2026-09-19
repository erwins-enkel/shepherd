import Foundation
import Testing
@testable import Shepherd

@MainActor
struct FolderPickerTests {
    /// Stand-in that proves the seam exists, so FirstRunSheet never has to reach
    /// NSOpenPanel directly and can be driven from a preview or a future test.
    struct FixedPicker: FolderPicking {
        let url: URL?
        func chooseFolder(prompt: String) -> URL? { url }
    }

    @Test func aPickerCanReturnAFolder() {
        let picker = FixedPicker(url: URL(fileURLWithPath: "/Users/me/code"))
        #expect(picker.chooseFolder(prompt: "pick")?.path == "/Users/me/code")
    }

    @Test func aCancelledPickReturnsNil() {
        #expect(FixedPicker(url: nil).chooseFolder(prompt: "pick") == nil)
    }

    @Test func theSheetAcceptsAnInjectedPicker() {
        let sheet = FirstRunSheet(picker: FixedPicker(url: URL(fileURLWithPath: "/tmp")))
        #expect(sheet.picker.chooseFolder(prompt: "pick")?.path == "/tmp")
    }

    @Test func theSystemPickerIsTheDefault() {
        #expect(FirstRunSheet().picker is SystemFolderPicker)
    }
}
