import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

/// Serialized: `ActionBarSlot` is per-process state, and `resetStreamSeams()` in `init` is what
/// keeps the fallback suites honest.
@MainActor
@Suite(.serialized)
struct ActionBarTests {
    init() { resetStreamSeams() }

    @Test func theSlotIsEmptyUntilTheStreamInstallsItself() {
        #expect(ActionBarSlot.resolution == .fallback)
        ActionsStream.install(
            AppModel(defaults: Self.scratchDefaults(), credentials: InMemoryCredentialStore()))
        #expect(ActionBarSlot.resolution == .slot)
    }

    @Test func installingTwiceRegistersOneExtension() {
        let app = AppModel(defaults: Self.scratchDefaults(), credentials: InMemoryCredentialStore())
        ActionsStream.install(app)
        ActionsStream.install(app)
        #expect(app.extensionFactories.count == 1)
    }

    @Test func theRecapLineNamesTheVerdictAndCountsOpenItems() {
        let ready = RecapLine.Content(
            verdict: L.t("recap_verdict_ready"), headline: "All green", openItems: 0)
        #expect(RecapLine.content(for: nil) == nil)

        let recap = Recap(
            sessionId: "s1", state: RecapState(known: .ready),
            verdict: RecapVerdict(known: .needsAttention), headline: "Two follow-ups open",
            body: "b", openItems: ["a", "b"], changedFiles: [], generatedAt: 1, updatedAt: 1)
        let content = RecapLine.content(for: recap)
        #expect(content?.verdict == L.t("recap_verdict_needs_attention"))
        #expect(content?.headline == "Two follow-ups open")
        #expect(content?.openItems == 2)
        #expect(content != ready)
    }

    @Test func aRecapStillGeneratingHasNoLineYet() {
        let recap = Recap(
            sessionId: "s1", state: RecapState(known: .generating), verdict: nil,
            headline: "", body: "", openItems: [], changedFiles: [], generatedAt: nil,
            updatedAt: 1)
        #expect(RecapLine.content(for: recap) == nil, "an empty headline is not a line")
    }

    @Test func anUnknownVerdictFallsBackToTheRawValue() {
        let recap = Recap(
            sessionId: "s1", state: RecapState(known: .ready),
            verdict: RecapVerdict(unknown: "quantum"), headline: "h", body: "b",
            openItems: [], changedFiles: [], generatedAt: 1, updatedAt: 1)
        #expect(RecapLine.content(for: recap)?.verdict == "quantum")
    }

    /// The two relaunch codes the shared `ShepherdErrorCopy` cannot reach: it renders the
    /// server's own `message` verbatim for both `.conflict` and `.upstreamFailure` and never
    /// looks at the code, and `SessionCommandState.run` hands `failureCopy` only that string.
    /// `ActionErrorCopy` is this stream's own, smallest bridge over that gap.
    @Test func theTwoRelaunchCodesGetTheirOwnSentence() {
        #expect(
            ActionErrorCopy.relaunchFailure(
                ShepherdError.conflict(code: "in_progress", message: "relaunch already in progress"),
                fallback: "relaunch already in progress") == L.t("relaunch_in_progress"))
        #expect(
            ActionErrorCopy.relaunchFailure(
                ShepherdError.upstreamFailure("could not re-resolve linked issue"),
                fallback: "could not re-resolve linked issue") == L.t("relaunch_issue_unresolved"))
    }

    @Test func anyOtherRelaunchFailureKeepsTheServersOwnWords() {
        #expect(
            ActionErrorCopy.relaunchFailure(
                ShepherdError.conflict(code: "already_archived", message: "already archived"),
                fallback: "already archived") == L.t("native_actions_failed", "already archived"))
        // A 502 from a failed spawn carries the runner's message, not a code.
        #expect(
            ActionErrorCopy.relaunchFailure(
                ShepherdError.upstreamFailure("worktree add failed"),
                fallback: "worktree add failed")
                == L.t("native_actions_failed", "worktree add failed"))
        #expect(
            ActionErrorCopy.relaunchFailure(ShepherdError.notFound, fallback: "gone")
                == L.t("native_actions_failed", "gone"))
        // Nothing was captured — a failure that never reached the kit's own error type.
        #expect(
            ActionErrorCopy.relaunchFailure(nil, fallback: "gone")
                == L.t("native_actions_failed", "gone"))
    }

    @Test func renameRejectsABlankNameAndReportsAPinnedBranch() {
        #expect(!RenameSubmission.validate(""))
        #expect(!RenameSubmission.validate("   "))
        #expect(RenameSubmission.validate("fresh name"))

        let moved = Components.Schemas.RenameResult(
            session: PreviewData.session(id: "s1", status: SessionStatus(known: .idle)),
            branchRenamed: true)
        var pinned = moved
        pinned.branchRenamed = false
        #expect(RenameSubmission.note(for: moved) == L.t("toast_renamed", moved.session.name))
        #expect(
            RenameSubmission.note(for: pinned) == L.t("viewport_rename_branch_kept"),
            "a display-only rename must say the branch stayed put")
    }

    @Test func aBranchlessRenameIsAPlainSuccess() {
        // The server answers `branchRenamed: false` for every session with no branch to move
        // (src/server.ts:3359-3362), not only for one whose branch an open PR pinned. Telling
        // the operator "branch kept" about a session that never had a branch is a lie.
        let branchless = Components.Schemas.RenameResult(
            session: PreviewData.session(
                id: "s2", status: SessionStatus(known: .idle), branch: nil),
            branchRenamed: false)
        #expect(
            RenameSubmission.note(for: branchless)
                == L.t("toast_renamed", branchless.session.name),
            "a session with no branch has no branch to keep")

        let withBranch = Components.Schemas.RenameResult(
            session: PreviewData.session(
                id: "s3", status: SessionStatus(known: .idle), branch: "feat/pinned"),
            branchRenamed: false)
        #expect(RenameSubmission.note(for: withBranch) == L.t("viewport_rename_branch_kept"))
    }

    @Test func anUnchangedNameIsANoOpAndNameTakenGetsItsOwnSentence() {
        // The web's commitRename (Viewport.svelte:1029) closes without calling the route when
        // the typed name matches the current one; Save is disabled on the same predicate.
        #expect(!RenameSubmission.validate("same name", current: "same name"))
        #expect(!RenameSubmission.validate("  same name  ", current: "same name"))
        #expect(RenameSubmission.validate("other name", current: "same name"))
        #expect(!RenameSubmission.validate("   ", current: "same name"))

        #expect(RenameSubmission.failureCopy("name_taken") == L.t("viewport_rename_name_taken"))
        #expect(RenameSubmission.failureCopy("boom") == L.t("viewport_rename_failed"))
        #expect(RenameSubmission.failureCopy("") == L.t("viewport_rename_failed"))
    }

    @Test func amendRejectsBlankAndOverLongTextAndReportsDelivery() {
        #expect(!AmendSubmission.validate(""))
        #expect(!AmendSubmission.validate("  \n "))
        #expect(AmendSubmission.validate("Also cover the admin route."))
        #expect(!AmendSubmission.validate(String(repeating: "x", count: AmendSubmission.maxCharacters + 1)))
        #expect(AmendSubmission.validate(String(repeating: "x", count: AmendSubmission.maxCharacters)))

        #expect(AmendSubmission.note(steered: true) == L.t("amend_recorded_and_steered"))
        #expect(AmendSubmission.note(steered: false) == L.t("amend_recorded_not_steered"))
    }

    @Test func intentMapsRelaunchToConfirmationOnlyAndNeverToExecution() {
        #expect(ActionBarView.intent(for: .relaunch) == .confirmRelaunch)
        #expect(ActionBarView.intent(for: .rename) == .presentSheet(.rename))
        #expect(ActionBarView.intent(for: .amend) == .presentSheet(.amend))
        #expect(ActionBarView.intent(for: .stop) == .execute)
        #expect(ActionBarView.intent(for: .resume) == .execute)
        #expect(ActionBarView.intent(for: .toggleReady) == .execute)
        #expect(ActionBarView.intent(for: .regenerateRecap) == .execute)
    }

    @Test func isCurrentDropsACompletionAfterTheOperatorSelectedAnotherSession() async throws {
        let app = AppModel(defaults: Self.scratchDefaults(), credentials: InMemoryCredentialStore())
        let profile = try app.addRemoteProfile(
            name: "action-bar-one", address: "https://action-bar-one.example.ts.net")
        await app.activate(profile)
        let store = try #require(app.store)
        app.selectedSessionID = "s1"

        #expect(ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: store, app: app))

        app.selectedSessionID = "s2"
        #expect(
            !ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: store, app: app),
            "a completion for a session the operator moved off must be dropped")
    }

    @Test func isCurrentDropsACompletionAfterAProfileSwitch() async throws {
        let app = AppModel(defaults: Self.scratchDefaults(), credentials: InMemoryCredentialStore())
        let profile = try app.addRemoteProfile(
            name: "action-bar-two", address: "https://action-bar-two.example.ts.net")
        await app.activate(profile)
        let activeStore = try #require(app.store)
        app.selectedSessionID = "s1"
        #expect(
            ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: activeStore, app: app))

        // The command went to a DIFFERENT store instance — the operator switched profiles while
        // it was in flight, even though the id it names is still selected under the new one.
        let otherClient = try ShepherdClient(
            profile: ServerProfile(
                name: "other", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local,
                credentialKey: "action-bar-other"),
            credentials: InMemoryCredentialStore())
        let otherStore = SessionStore(client: otherClient)
        #expect(
            !ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: otherStore, app: app),
            "a completion for a store the operator switched away from must be dropped")
    }

    /// A throwaway suite so the test never reads or writes the operator's own profiles. Pair it
    /// with `InMemoryCredentialStore()` at every call site: `AppModel.init` defaults `credentials`
    /// to `KeychainCredentialStore()`, and that is the unattended-run stall this plan's "No
    /// Keychain prompts" constraint exists to prevent. Every existing app test does the same.
    private static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "run.shepherd.mac.actiontests.\(UUID().uuidString)")!
    }
}
