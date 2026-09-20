import SwiftUI
import ShepherdKit
import Testing

@testable import Shepherd

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

    /// Every notice that predates the tone — a command failure in the window and in the two
    /// sheets, the git tab's, and the sign-out revoke warning — must keep the chrome it had, so
    /// the parameter defaults rather than being required at those call sites.
    @Test func theDefaultIsStillAWarning() {
        #expect(NoticeBar(message: "revoke failed") {}.tone == .warning)
    }

    /// A relaunch that archived the original is the whole thing having worked. One that did not
    /// left the operator a session to close by hand, so it keeps the warning chrome even though
    /// nothing threw.
    @Test func onlyACompleteRelaunchReadsAsSuccess() {
        let replacement = PreviewData.session(id: "s2", desig: "TASK-08")
        let archived = ActionBarView.relaunchOutcomeNote(
            RelaunchResult(session: replacement, archived: true))
        #expect(archived.tone == .success)
        #expect(archived.text == L.t("relaunch_done", "TASK-08"))

        let halfDone = ActionBarView.relaunchOutcomeNote(
            RelaunchResult(session: replacement, archived: false))
        #expect(halfDone.tone == .warning)
        #expect(halfDone.text == L.t("relaunch_archive_failed"))
    }

    @Test func theTwoConstructorsCarryTheirTone() {
        #expect(ActionNote.success("Stopped TASK-07").tone == .success)
        #expect(ActionNote.success("Stopped TASK-07").text == "Stopped TASK-07")
        #expect(ActionNote.warning("could not archive").tone == .warning)
    }
}
