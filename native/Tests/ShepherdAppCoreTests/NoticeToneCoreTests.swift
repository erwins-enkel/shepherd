import SwiftUI
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
/// `NoticeBar`'s two tones, asserted at the value level — the mapping and the default, not what
/// SwiftUI draws. Hosting the bar to find out would need a window server and would prove nothing
/// the chrome's own two properties do not already say.
@MainActor
struct NoticeToneTests {
    @Test func theTwoTonesDoNotShareChrome() {
        #expect(NoticeTone.warning.systemImage == "exclamationmark.triangle.fill")
        #expect(NoticeTone.success.systemImage == "checkmark.circle.fill")
        #expect(NoticeTone.warning.tint == .orange)
        #expect(NoticeTone.success.tint == .green)
        #expect(NoticeTone.warning.systemImage != NoticeTone.success.systemImage)
        #expect(NoticeTone.warning.tint != NoticeTone.success.tint)
    }

    @Test func theTwoConstructorsCarryTheirTone() {
        #expect(ActionNote.success("Stopped TASK-07").tone == .success)
        #expect(ActionNote.success("Stopped TASK-07").text == "Stopped TASK-07")
        #expect(ActionNote.warning("could not archive").tone == .warning)
    }
}
}
