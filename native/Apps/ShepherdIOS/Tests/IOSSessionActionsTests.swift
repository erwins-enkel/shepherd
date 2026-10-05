import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSSessionActionsTests: XCTestCase {
    func testHeaderMenuKeepsEveryRailActionAcrossStatusesAndReadOnly() {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        XCTAssertTrue(IOSSessionHeaderActions.actions(fixture.state).contains(.stop))
        XCTAssertTrue(IOSSessionHeaderActions.actions(fixture.state).contains(.rename))
        XCTAssertTrue(IOSSessionHeaderActions.actions(fixture.state).contains(.amend))
        XCTAssertTrue(IOSSessionHeaderActions.actions(fixture.state).contains(.regenerateRecap))
        fixture.session.status = .init(known: .done)
        XCTAssertTrue(IOSSessionHeaderActions.actions(fixture.state).contains(.resume))
        XCTAssertTrue(IOSSessionHeaderActions.actions(fixture.state).contains(.toggleReady))
        for status in [SessionStatusKnown.running, .blocked, .done, .idle, .archived] {
            fixture.session.status = .init(known: status)
            for writable in [true, false] {
                fixture.writable = writable
                XCTAssertEqual(IOSSessionHeaderActions.actions(fixture.state), fixture.state.actions)
                XCTAssertTrue(Set(fixture.state.swipeActions).isSubset(of: Set(IOSSessionHeaderActions.actions(fixture.state))))
            }
        }
    }

    func testSwipeChoicesUseSharedAvailabilityAndStatefulReadyLabels() {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        XCTAssertEqual(fixture.state.swipeActions, [.stop])
        fixture.session.status = .init(known: .done)
        XCTAssertEqual(fixture.state.swipeActions, [.resume, .toggleReady])
        XCTAssertEqual(IOSSessionActionState.label(.toggleReady, session: fixture.session), L.t("native_ios_actions_ready"))
        fixture.session.readyToMerge = true
        XCTAssertEqual(IOSSessionActionState.label(.toggleReady, session: fixture.session), L.t("native_ios_actions_not_ready"))
        XCTAssertFalse(fixture.state.actions.contains(.relaunch))
        fixture.session.status = .init(known: .archived)
        XCTAssertTrue(fixture.state.swipeActions.isEmpty)
        XCTAssertTrue(fixture.state.actions.isEmpty)
    }

    func testReadyUsesWebOpenPRGateAndAlreadyReadyBackstop() {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.session.status = .init(known: .done)
        fixture.git.state = .init(known: .none)
        XCTAssertFalse(fixture.state.actions.contains(.toggleReady))
        fixture.session.readyToMerge = true
        XCTAssertTrue(fixture.state.actions.contains(.toggleReady))
        fixture.session.status = .init(known: .running)
        XCTAssertFalse(fixture.state.actions.contains(.toggleReady))
    }

    func testIsolatedAndInvalidatedStatesRejectEveryWriteIncludingDirectCalls() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.writable = false
        for action in SessionAction.allCases {
            fixture.state.present(action)
            await fixture.state.execute(action)
        }
        fixture.session.readyToMerge = true
        fixture.state.prepareMerge()
        fixture.state.confirmMerge(now: .distantFuture)
        await fixture.state.submit()
        XCTAssertTrue(fixture.calls.isEmpty)
        XCTAssertNil(fixture.state.sheet)
        fixture.writable = true
        fixture.state.invalidate()
        await fixture.state.execute(.stop)
        XCTAssertTrue(fixture.calls.isEmpty)
    }

    func testStopResumeReadyAndRecapReuseCoreSuccessAndFailureCopy() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        await fixture.state.execute(.stop)
        XCTAssertEqual(fixture.state.outcome.note, .success(L.t("cardmenu_stop_toast", fixture.session.name)))
        fixture.session.status = .init(known: .done)
        await fixture.state.execute(.resume)
        XCTAssertEqual(fixture.state.outcome.note, .success(L.t("native_actions_resumed", fixture.session.name)))
        await fixture.state.execute(.toggleReady)
        XCTAssertEqual(fixture.readyValue, true)
        fixture.session.readyToMerge = true
        await fixture.state.execute(.toggleReady)
        XCTAssertEqual(fixture.readyValue, false)
        await fixture.state.execute(.regenerateRecap)
        XCTAssertEqual(fixture.state.outcome.note, .success(L.t("native_actions_recap_requested")))
        fixture.error = ShepherdError.notFound
        await fixture.state.execute(.resume)
        XCTAssertEqual(fixture.state.command.message, L.t("cardmenu_resume_failed", fixture.session.name))
        XCTAssertNil(fixture.state.outcome.note)
        fixture.error = nil; fixture.recapOK = false
        await fixture.state.execute(.regenerateRecap)
        XCTAssertEqual(fixture.state.command.message, L.t("recap_regenerate_failed"))
    }

    func testBusyCommandsCannotOverlapAndLateActivationFailureIsDropped() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.hold = true
        let first = Task { await fixture.state.execute(.stop) }
        await settle { fixture.pending != nil }
        XCTAssertTrue(fixture.state.busy)
        await fixture.state.execute(.stop)
        fixture.state.present(.rename)
        XCTAssertNil(fixture.state.sheet)
        XCTAssertEqual(fixture.calls, ["stop"])
        fixture.writable = false; fixture.error = ShepherdError.notFound
        fixture.release()
        await first.value
        XCTAssertFalse(fixture.state.busy)
        XCTAssertNil(fixture.state.error)
        XCTAssertNil(fixture.state.outcome.note)
    }

    func testRenameValidationTrimBranchKeptAndNameTakenCopy() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.state.present(.rename)
        XCTAssertFalse(fixture.state.canSubmit)
        fixture.state.name = " \n "
        await fixture.state.submit()
        XCTAssertTrue(fixture.calls.isEmpty)
        fixture.state.name = "  shorter task  "
        fixture.branchRenamed = false
        await fixture.state.submit()
        XCTAssertEqual(fixture.renameName, "shorter task")
        XCTAssertEqual(fixture.state.outcome.note, .success(L.t("viewport_rename_branch_kept")))
        XCTAssertNil(fixture.state.sheet)
        fixture.state.present(.rename); fixture.state.name = "other task"
        fixture.error = ShepherdError.conflict(code: nil, message: "name_taken")
        await fixture.state.submit()
        XCTAssertEqual(fixture.state.error, RenameSubmission.failureCopy("name_taken"))
        XCTAssertEqual(fixture.state.name, "other task")
        XCTAssertEqual(fixture.state.sheet, .rename)
    }

    func testAmendUTF16LimitAndDeliveryNotePreserveDraftOnFailure() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.state.present(.amend)
        fixture.state.amendment = String(repeating: "😀", count: 1001)
        XCTAssertFalse(fixture.state.canSubmit)
        await fixture.state.submit()
        XCTAssertTrue(fixture.calls.isEmpty)
        fixture.state.amendment = "  Also cover Codex\nwith tests.  "
        fixture.steered = false
        await fixture.state.submit()
        XCTAssertEqual(fixture.amendedText, "Also cover Codex\nwith tests.")
        XCTAssertEqual(fixture.state.outcome.note, .success(AmendSubmission.note(steered: false)))
        fixture.state.present(.amend)
        fixture.state.amendment = "Keep this draft"; fixture.state.steer = false
        fixture.error = ShepherdError.notFound
        await fixture.state.submit()
        XCTAssertEqual(fixture.state.amendment, "Keep this draft")
        XCTAssertEqual(fixture.state.error, L.t("amend_failed"))
        fixture.error = nil
        await fixture.state.submit()
        XCTAssertEqual(fixture.state.outcome.note, .success(L.t("amend_recorded")))
    }

    func testSheetCompletionCannotTouchAChangedSelection() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.state.present(.rename); fixture.state.name = "new name"; fixture.hold = true
        let task = Task { await fixture.state.submit() }
        await settle { fixture.pending != nil }
        fixture.selected = false; fixture.replacementAllowed = false
        fixture.state.detailDidDisappear()
        fixture.selected = true
        fixture.release(); await task.value
        XCTAssertNil(fixture.state.outcome.note)
        XCTAssertNil(fixture.state.sheet)
    }

    func testRelaunchRequiresOptionsConfirmationAndSendsOnlyChangedOverrides() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        await fixture.state.execute(.relaunch)
        XCTAssertTrue(fixture.calls.isEmpty)
        fixture.state.present(.relaunch)
        XCTAssertEqual(fixture.state.sheet, .relaunch)
        let unchanged = IOSSessionActionState.relaunchRequest(session: fixture.session,
            repo: fixture.session.repoPath, branch: fixture.session.baseBranch, prompt: fixture.session.prompt)
        XCTAssertNil(unchanged.repoPath); XCTAssertNil(unchanged.baseBranch); XCTAssertNil(unchanged.prompt)
        fixture.state.repo = "/repos/elsewhere"; fixture.state.branch = "develop"; fixture.state.prompt = "Start again"
        await fixture.state.submit()
        XCTAssertEqual(fixture.relaunchRequest?.repoPath, "/repos/elsewhere")
        XCTAssertEqual(fixture.relaunchRequest?.baseBranch, "develop")
        XCTAssertEqual(fixture.relaunchRequest?.prompt, "Start again")
        XCTAssertNil(fixture.relaunchRequest?.agentProvider)
        XCTAssertNil(fixture.relaunchRequest?.model)
        XCTAssertEqual(fixture.selectedReplacement?.id, "replacement")
        XCTAssertEqual(fixture.replacementNote, .success(L.t("relaunch_done", "TASK-02")))
    }

    func testRelaunchPartialArchiveAndCodedErrors() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.archived = false
        fixture.state.present(.relaunch); await fixture.state.submit()
        XCTAssertEqual(fixture.state.outcome.note, .warning(L.t("relaunch_archive_failed")))
        XCTAssertNil(fixture.selectedReplacement)
        let cases: [(ShepherdError, StaticString)] = [(ShepherdError.conflict(code: "in_progress", message: "busy"), "relaunch_in_progress"),
                             (.upstreamFailure(code: "issue_unresolved", message: "missing"), "relaunch_issue_unresolved")]
        for (error, key) in cases {
            fixture.state.present(.relaunch); fixture.error = error
            await fixture.state.submit()
            XCTAssertEqual(fixture.state.error, L.t(key))
            XCTAssertEqual(fixture.state.sheet, .relaunch)
        }
    }

    func testRelaunchArchiveCanSelectReplacementButNeverStealsExplicitNavigation() async {
        for canSelect in [true, false] {
            let fixture = IOSActionFixture()
            defer { fixture.merge.teardown() }
            fixture.state.present(.relaunch); fixture.hold = true
            let task = Task { await fixture.state.submit() }
            await settle { fixture.pending != nil }
            fixture.selected = false; fixture.replacementAllowed = canSelect
            fixture.release(); await task.value
            XCTAssertEqual(fixture.selectedReplacement != nil, canSelect)
        }
    }

    func testMergeFetchesFreshContextArmsAndEchoesServerResponsibility() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.session.readyToMerge = true
        XCTAssertTrue(fixture.state.canMerge(fixture.session, git: [fixture.session.id: fixture.git], reviewing: false))
        XCTAssertFalse(fixture.state.canMerge(fixture.session, git: [fixture.session.id: fixture.git], reviewing: true))
        XCTAssertFalse(fixture.state.canMerge(fixture.session, git: [:], reviewing: false))
        fixture.state.prepareMerge()
        await settle { fixture.state.sheet == .merge }
        XCTAssertEqual(fixture.calls, ["git"])
        let opened = try XCTUnwrap(fixture.state.presentedAt)
        XCTAssertFalse(fixture.state.canConfirmMerge(now: opened))
        fixture.state.confirmMerge(now: opened)
        XCTAssertEqual(fixture.calls, ["git"])
        XCTAssertTrue(fixture.state.canConfirmMerge(now: opened.addingTimeInterval(0.4)))
        fixture.state.method = .rebase; fixture.state.deleteBranch = false
        fixture.state.confirmMerge(now: opened.addingTimeInterval(0.4))
        await settle { fixture.mergePayload != nil && !fixture.merge.busy }
        XCTAssertEqual(fixture.mergePayload?.headSha, "fresh-head")
        XCTAssertEqual(fixture.mergePayload?.baseRefName, "develop")
        XCTAssertEqual(fixture.mergePayload?.handoff?.rawValue, "reviewer")
        XCTAssertEqual(fixture.mergePayload?.handoffWho, "alex")
        XCTAssertEqual(fixture.mergePayload?.reviewBlockBy, "sam")
        XCTAssertEqual(fixture.mergeMethod, .rebase); XCTAssertEqual(fixture.deleteBranch, false)
        XCTAssertEqual(fixture.state.outcome.note, .success(L.t("prbadge_merged_toast", "42")))
        XCTAssertNil(fixture.state.candidate)
        XCTAssertFalse(fixture.state.canConfirmMerge(now: .distantFuture))
    }

    func testMergeRefusalSpendsConfirmationAndRetryMustFetchAgain() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.session.readyToMerge = true
        fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
        fixture.error = ShepherdError.conflict(code: "merge_confirm_stale", message: "Revision changed")
        fixture.state.confirmMerge(now: .distantFuture)
        await settle { fixture.state.candidate == nil && !fixture.merge.busy }
        XCTAssertNotNil(fixture.state.error)
        fixture.state.confirmMerge(now: .distantFuture)
        XCTAssertEqual(fixture.calls, ["git", "merge"])
        fixture.error = nil
        fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
        XCTAssertEqual(fixture.calls, ["git", "merge", "git"])
        XCTAssertFalse(fixture.state.canConfirmMerge(now: fixture.state.presentedAt!))
    }

    func testMergeUsesServerDefaultUnlessExplicitlyOverriddenAndResetsOnReopen() async {
        let methods: [MergeMethod?] = [nil, .squash, .merge, .rebase]
        for method in methods {
            let fixture = IOSActionFixture()
            defer { fixture.merge.teardown() }
            fixture.session.readyToMerge = true
            fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
            XCTAssertNil(fixture.state.method)
            fixture.state.method = method
            fixture.state.confirmMerge(now: .distantFuture)
            await settle { fixture.calls.contains("merge") && !fixture.state.busy }
            XCTAssertEqual(fixture.mergeMethod, method)
            XCTAssertEqual(fixture.deleteBranch, true)
            fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
            XCTAssertNil(fixture.state.method, "A fresh confirmation must restore the server default")
        }
    }

    func testMergeSerializationAndRefusalsOnlyAffectTheOriginatingSession() async {
        let first = IOSActionFixture()
        let second = IOSActionFixture(merge: first.merge)
        second.session.id = "other"
        defer { first.merge.teardown() }
        first.session.readyToMerge = true; second.session.readyToMerge = true
        first.state.prepareMerge(); await settle { first.state.candidate != nil }
        first.hold = true
        first.state.confirmMerge(now: .distantFuture)
        await settle { first.pending != nil }
        XCTAssertTrue(first.state.busy)
        XCTAssertFalse(second.state.busy)
        second.state.prepareMerge()
        XCTAssertNil(second.state.sheet)
        await second.state.execute(.stop)
        second.session.status = .init(known: .done)
        await second.state.execute(.resume)
        XCTAssertEqual(second.calls, ["stop", "resume"])
        XCTAssertNotNil(second.state.outcome.note)
        // The originating session also rejects concurrent lifecycle writes.
        await first.state.execute(.stop)
        XCTAssertEqual(first.calls, ["git", "merge"])
        first.error = .conflict(code: "merge_confirm_stale", message: "Revision changed")
        first.release()
        await settle { !first.state.busy }
        XCTAssertNotNil(first.state.error)
        XCTAssertNil(second.state.error)
        XCTAssertFalse(second.state.busy)
        first.error = nil
        await first.state.execute(.stop)
        XCTAssertNil(first.state.error, "Successful lifecycle commands clear this session's old refusal")
        XCTAssertNotNil(first.state.outcome.note)
    }

    func testMergePreparationErrorsAreLocalAndBackgroundSnapshotErrorsDoNotLeak() async {
        let merge = MergeModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
        let first = IOSActionFixture(merge: merge)
        let second = IOSActionFixture(merge: merge)
        defer { merge.teardown() }
        await merge.refresh()
        XCTAssertNotNil(merge.error)
        XCTAssertNil(first.state.error); XCTAssertNil(second.state.error)
        first.session.readyToMerge = true
        first.error = .notFound
        first.state.prepareMerge()
        await settle { first.calls == ["git"] && !first.state.busy }
        XCTAssertNotNil(first.state.error)
        XCTAssertNil(first.state.sheet)
        XCTAssertNil(second.state.error)
        await second.state.execute(.stop)
        XCTAssertNil(second.state.error)
        XCTAssertNotNil(second.state.outcome.note)
    }

    func testLateMergeFailureAfterNavigationIsDroppedAndUnlocksOrigin() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.session.readyToMerge = true; fixture.hold = true
        fixture.state.prepareMerge(); await settle { fixture.pending != nil }
        fixture.selected = false; fixture.replacementAllowed = false
        fixture.state.detailDidDisappear()
        fixture.error = .notFound; fixture.release()
        await settle { !fixture.state.busy }
        XCTAssertNil(fixture.state.error)
        XCTAssertNil(fixture.state.sheet)
    }

    func testCachePrunesRemovedStatesRetainsSelectedArchiveAndWaitsForCommandCompletion() async throws {
        resetStreamSeams()
        defer { resetStreamSeams() }
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let profile = try app.addRemoteProfile(name: "Fixture", address: "http://127.0.0.1:1")
        await app.activate(profile)
        defer { app.deactivate() }
        // The activated store keeps bootstrapping against the unreachable address and
        // holds every pushed frame in its snapshot-load buffer until a load ends, so it
        // cannot order these events. An unstarted store applies them synchronously; only
        // the Actions and Merge extensions are borrowed from the activation.
        let store = try SessionStore(profile: ServerProfile(name: "fixture",
            baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local), credentials: InMemoryCredentialStore())
        let controller = IOSSessionActions(store: store, app: app)
        defer { controller.teardown() }
        let session = PreviewData.session()
        store.apply(.sessionNew(session))
        var state: IOSSessionActionState? = controller.state(for: session)
        state?.amendment = "saved draft"
        weak var removed = state
        app.selectedSessionID = session.id
        store.apply(.sessionArchived(.init(id: session.id)))
        // A later list change exercises reconciliation while the archive is selected.
        let live = PreviewData.session(id: "live")
        store.apply(.sessionNew(live))
        _ = controller.state(for: live)
        await settle { controller.cachedSessionIDs.contains(live.id) }
        XCTAssertTrue(state === controller.state(for: session))
        XCTAssertEqual(state?.amendment, "saved draft")
        app.selectedSessionID = nil
        state = nil
        await settle { removed == nil && !controller.cachedSessionIDs.contains(session.id) }

        let inFlight = controller.state(for: live)
        var pending: CheckedContinuation<Void, Never>?
        var completed = false
        let relaunch = Task {
            await inFlight.command.run({
                // Relaunch archives its source before the request returns its replacement.
                store.apply(.sessionArchived(.init(id: live.id)))
                await withCheckedContinuation { pending = $0 }
                completed = true
            }, failureCopy: { $0 }, isCurrent: { true })
        }
        await settle { pending != nil }
        // Another removed row must be pruned without dropping the unfinished relaunch.
        let other = PreviewData.session(id: "other")
        store.apply(.sessionNew(other))
        _ = controller.state(for: other)
        store.apply(.sessionArchived(.init(id: other.id)))
        await settle { !controller.cachedSessionIDs.contains(other.id) }
        XCTAssertTrue(controller.cachedSessionIDs.contains(live.id))
        XCTAssertTrue(inFlight.command.busy)
        pending?.resume(); pending = nil
        _ = await relaunch.value
        await settle { controller.cachedSessionIDs.isEmpty }
        XCTAssertTrue(completed)
        XCTAssertNil(inFlight.sheet)
    }

    func testMergeRejectsUnknownRolesLostReadyAndChangedSelection() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.session.readyToMerge = true
        fixture.git = try IOSActionFixture.decodeGit(handoff: "future-role")
        fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
        XCTAssertFalse(fixture.state.canConfirmMerge(now: .distantFuture))
        fixture.state.dismiss(); fixture.git = try IOSActionFixture.decodeGit()
        fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
        fixture.session.readyToMerge = false
        fixture.state.confirmMerge(now: .distantFuture)
        fixture.session.readyToMerge = true; fixture.selected = false
        fixture.state.confirmMerge(now: .distantFuture)
        XCTAssertEqual(fixture.calls, ["git", "git"])
    }

    func testActivationInstallsActionsAndMergeInputsWithoutMacHost() async throws {
        resetStreamSeams()
        defer { resetStreamSeams() }
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let profile = try app.addRemoteProfile(name: "Fixture", address: "http://127.0.0.1:1")
        await app.activate(profile)
        defer { app.deactivate() }
        XCTAssertNotNil(app.extension(IOSSessionActions.self))
        XCTAssertNotNil(app.extension(ActionsModel.self)); XCTAssertNotNil(app.extension(MergeModel.self))
        XCTAssertTrue(MergeInputs.planReviewBlocked(app, "missing"))
        XCTAssertTrue(MergeInputs.terminalEnded(app, "missing"))
        let session = PreviewData.session()
        app.store?.apply(.sessionNew(session))
        let controller = try XCTUnwrap(app.extension(IOSSessionActions.self))
        let state = controller.state(for: session)
        XCTAssertTrue(state === controller.state(for: session))
        XCTAssertFalse(state.allowsWrites)
        await state.execute(.stop)
        XCTAssertEqual(app.liveRequestAudit?.counts.rejected, 0)
        app.deactivate()
        XCTAssertFalse(state.allowsWrites)
        // Prove cleanup restores conservative defaults instead of keeping the
        // process-wide closures installed by makeModel().
        MergeInputs.reviewing = { _, _ in true }
        MergeInputs.git = { _ in [session.id: try! IOSActionFixture.decodeGit()] }
        resetStreamSeams()
        XCTAssertFalse(MergeInputs.reviewing(app, session.id))
        XCTAssertTrue(MergeInputs.git(app).isEmpty)
        XCTAssertTrue(MergeInputs.planReviewBlocked(app, session.id))
        XCTAssertTrue(MergeInputs.terminalEnded(app, session.id))
    }

    func testDecommissionIsOfferedForEveryLiveSessionBehindTheWriteGates() {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        for status in [SessionStatusKnown.running, .blocked, .idle, .done] {
            fixture.session.status = .init(known: status)
            XCTAssertTrue(fixture.state.canDecommission)
        }
        fixture.session.status = .init(known: .archived)
        XCTAssertFalse(fixture.state.canDecommission)
        fixture.state.presentDecommission()
        XCTAssertNil(fixture.state.sheet)
        fixture.session.status = .init(known: .done)
        fixture.writable = false
        XCTAssertFalse(fixture.state.canDecommission)
        fixture.state.presentDecommission()
        XCTAssertNil(fixture.state.sheet)
        fixture.writable = true; fixture.selected = false
        fixture.state.presentDecommission()
        XCTAssertNil(fixture.state.sheet)
        XCTAssertTrue(fixture.calls.isEmpty)
    }

    func testDecommissionWithoutOpenPRArchivesWithTheCheckedLeftoversAndLeaves() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.noPR = true
        fixture.listing = try IOSActionFixture.decodeLeftovers(["vite", "tailscale"])
        fixture.state.presentDecommission()
        XCTAssertEqual(fixture.state.sheet, .decommission)
        XCTAssertFalse(fixture.state.canConfirmDecommission(.keep))
        await settle { fixture.state.decommissionDraft.loaded }
        XCTAssertEqual(fixture.calls, ["leftovers", "git"])
        XCTAssertEqual(fixture.state.reap, ["vite", "tailscale"])
        XCTAssertNil(fixture.state.decommissionOpenPR)
        XCTAssertEqual(fixture.state.decommissionChoices, [.keep])
        XCTAssertFalse(fixture.state.canConfirmDecommission(.close))
        XCTAssertEqual(IOSDecommissionContent.title(.keep, pr: nil), L.t("cardmenu_decommission"))
        fixture.state.reap.remove("tailscale")
        await fixture.state.decommission(.keep)
        XCTAssertEqual(fixture.calls, ["leftovers", "git", "archive"])
        XCTAssertEqual(fixture.archivedReap, ["vite"])
        XCTAssertNil(fixture.state.sheet)
        XCTAssertEqual(fixture.decommissioned, 1)
    }

    func testDecommissionClosesOrMergesTheFreshPRBeforeArchiving() async {
        let closing = IOSActionFixture()
        defer { closing.merge.teardown() }
        closing.state.presentDecommission()
        await settle { closing.state.decommissionDraft.loaded }
        XCTAssertEqual(closing.state.decommissionChoices, [.keep, .merge, .close])
        await closing.state.decommission(.close)
        XCTAssertEqual(closing.calls, ["leftovers", "git", "closePR", "archive"])
        XCTAssertEqual(closing.archivedReap, [])
        XCTAssertEqual(closing.decommissioned, 1)

        let merging = IOSActionFixture()
        defer { merging.merge.teardown() }
        var fresh = merging.git; fresh.headSha = "decommission-head"
        merging.freshGit = fresh
        merging.state.presentDecommission()
        await settle { merging.state.decommissionDraft.loaded }
        await merging.state.decommission(.merge)
        XCTAssertEqual(merging.calls, ["leftovers", "git", "merge", "archive"])
        XCTAssertEqual(merging.mergePayload?.headSha, "decommission-head")
        XCTAssertEqual(merging.mergePayload?.handoffWho, "alex")
        XCTAssertEqual(merging.mergePayload?.reviewBlockBy, "sam")
        XCTAssertEqual(merging.deleteBranch, true)
        XCTAssertNil(merging.mergeMethod)
        XCTAssertEqual(merging.decommissioned, 1)
    }

    func testDecommissionOffersMergeOnlyWhereThePRCanMergeAndNamesATakeover() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.git.isDraft = true
        fixture.state.presentDecommission()
        await settle { fixture.state.decommissionDraft.loaded }
        XCTAssertEqual(fixture.state.decommissionChoices, [.keep, .close])
        XCTAssertFalse(fixture.state.canConfirmDecommission(.merge))
        await fixture.state.decommission(.merge)
        XCTAssertEqual(fixture.calls, ["leftovers", "git"])
        let pr = try XCTUnwrap(fixture.state.decommissionOpenPR)
        XCTAssertEqual(IOSDecommissionContent.title(.merge, pr: pr), L.t("decommission_pr_merge_takeover"))
        var unassigned = pr; unassigned.mergeGate = nil
        XCTAssertEqual(IOSDecommissionContent.title(.merge, pr: unassigned), L.t("decommission_pr_merge"))
        XCTAssertEqual(IOSDecommissionContent.title(.keep, pr: pr), L.t("decommission_pr_keep"))
        XCTAssertEqual(IOSDecommissionContent.title(.close, pr: pr), L.t("decommission_pr_close"))
    }

    func testDecommissionRetryAfterAFailedArchiveSkipsTheSettledPRStep() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.failOnce["archive"] = .notFound
        fixture.state.presentDecommission()
        await settle { fixture.state.decommissionDraft.loaded }
        await fixture.state.decommission(.close)
        XCTAssertEqual(fixture.calls, ["leftovers", "git", "closePR", "archive"])
        XCTAssertEqual(fixture.state.sheet, .decommission)
        XCTAssertEqual(fixture.state.error, L.t("native_archive_failed", ShepherdErrorCopy.message(ShepherdError.notFound)))
        XCTAssertNil(fixture.state.decommissionOpenPR)
        XCTAssertEqual(fixture.state.decommissionChoices, [.keep])
        XCTAssertEqual(fixture.decommissioned, 0)
        await fixture.state.decommission(.keep)
        XCTAssertEqual(fixture.calls, ["leftovers", "git", "closePR", "archive", "archive"])
        XCTAssertNil(fixture.state.sheet)
        XCTAssertEqual(fixture.decommissioned, 1)
    }

    func testDecommissionMergeFailureAsksAgainOnTheServersPRWithoutArchiving() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.state.presentDecommission()
        await settle { fixture.state.decommissionDraft.loaded }
        fixture.failOnce["merge"] = .notFound
        var current = fixture.git; current.headSha = "server-head"
        fixture.freshGit = current
        await fixture.state.decommission(.merge)
        XCTAssertEqual(fixture.calls, ["leftovers", "git", "merge", "git"])
        XCTAssertTrue(fixture.state.decommissionDraft.loaded)
        XCTAssertEqual(fixture.state.decommissionOpenPR?.headSha, "server-head")
        XCTAssertEqual(fixture.state.sheet, .decommission)
        XCTAssertNotNil(fixture.state.error)
        XCTAssertNil(fixture.archivedReap)
        XCTAssertEqual(fixture.decommissioned, 0)
    }

    func testDecommissionLoadFailuresNeverBlockTheClose() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.failOnce = ["leftovers": .notFound, "git": .notFound]
        fixture.state.presentDecommission()
        await settle { fixture.state.decommissionDraft.loaded }
        XCTAssertNil(fixture.state.decommissionDraft.listing)
        XCTAssertTrue(fixture.state.reap.isEmpty)
        XCTAssertEqual(fixture.state.decommissionOpenPR?.headSha, "fresh-head", "the cached PR stands in for a failed read")
        XCTAssertTrue(fixture.state.canConfirmDecommission(.keep))
        XCTAssertNil(fixture.state.error)

        let blind = IOSActionFixture()
        defer { blind.merge.teardown() }
        blind.listing = try IOSActionFixture.decodeLeftovers([], probesUnavailable: true)
        blind.state.presentDecommission()
        await settle { blind.state.decommissionDraft.loaded }
        XCTAssertEqual(blind.state.decommissionDraft.listing?.probesUnavailable, true)
    }

    func testLateDecommissionLoadAndCompletionAfterLeavingChangeNothing() async {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        fixture.hold = true
        fixture.state.presentDecommission()
        await settle { fixture.calls == ["leftovers"] }
        fixture.state.dismiss()
        fixture.release()
        await settle { fixture.calls == ["leftovers", "git"] }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNil(fixture.state.sheet)
        XCTAssertFalse(fixture.state.decommissionDraft.loaded)

        fixture.state.presentDecommission()
        await settle { fixture.state.decommissionDraft.loaded }
        fixture.hold = true
        let write = Task { await fixture.state.decommission(.keep) }
        await settle { fixture.calls.last == "archive" }
        fixture.selected = false; fixture.replacementAllowed = false
        fixture.state.detailDidDisappear()
        fixture.release()
        await write.value
        XCTAssertNil(fixture.state.sheet)
        XCTAssertNil(fixture.state.error)
        XCTAssertEqual(fixture.decommissioned, 0)
    }

    func testRenderFixtureImages() async throws {
        let fixture = IOSActionFixture()
        defer { fixture.merge.teardown() }
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-actions")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let recap = Recap(sessionId: fixture.session.id, state: .init(known: .ready), verdict: .init(known: .ready),
            headline: "iPhone session steering is ready", body: "Added shared session commands and deliberate merge confirmation.",
            openItems: ["Check the iPhone layout before shipping."], changedFiles: ["Actions/IOSSessionActions.swift"], updatedAt: 1)
        func render<V: View>(_ view: V, _ name: String, large: Bool = false, height: CGFloat = 700) throws {
            let framed = view.padding(16).frame(width: 390, height: height, alignment: .topLeading)
                .background(SessionListStyle.background).preferredColorScheme(.dark)
                .environment(\.dynamicTypeSize, large ? .accessibility1 : .large)
            let renderer = ImageRenderer(content: framed); renderer.scale = 2
            try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
        }
        func bar(_ ready: Bool = false) -> some View {
            IOSSessionActionBarContent(session: fixture.session, state: fixture.state, recap: recap, repos: [], canMerge: ready, rendersStaticFixture: true)
        }
        try render(bar(), "actions-running", height: 330)
        fixture.session.status = .init(known: .done); fixture.session.readyToMerge = true
        try render(bar(true), "actions-ready", height: 380)
        try render(bar(true), "actions-large-type", large: true, height: 650)
        fixture.writable = false
        try render(bar(), "actions-read-only", height: 380)
        fixture.writable = true; fixture.session.readyToMerge = false
        fixture.state.present(.amend); fixture.state.amendment = "Also check the German labels with VoiceOver."
        try render(IOSActionEditorContent(session: fixture.session, state: fixture.state, repos: [], kind: .amend,
            rendersStaticFixture: true), "amend")
        fixture.state.present(.relaunch)
        try render(IOSActionEditorContent(session: fixture.session, state: fixture.state, repos: [], kind: .relaunch,
            rendersStaticFixture: true), "relaunch")
        fixture.state.dismiss(); fixture.session.readyToMerge = true
        fixture.state.prepareMerge(); await settle { fixture.state.candidate != nil }
        try render(IOSMergeConfirmationContent(session: fixture.session, state: fixture.state,
            clock: .distantFuture, rendersStaticFixture: true), "merge-confirmation", height: 760)
        try render(IOSRecapContent(recap: recap), "recap")
        try render(IOSActionFeedback(error: L.t("recap_regenerate_failed"), busy: true, rendersStaticFixture: true), "progress-error", height: 250)
        try render(IOSActionFeedback(note: .success(L.t("prbadge_merged_toast", "42"))), "merge-success", height: 200)
        fixture.state.dismiss()
        fixture.listing = try IOSActionFixture.decodeLeftovers(["vite"])
        fixture.state.presentDecommission(); await settle { fixture.state.decommissionDraft.loaded }
        try render(IOSDecommissionContent(session: fixture.session, state: fixture.state, rendersStaticFixture: true),
            "decommission-open-pr", height: 760)
    }

    private func settle(line: UInt = #line, _ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(15)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition(), line: line)
    }
}

@MainActor
private final class IOSActionFixture {
    var session = PreviewData.session(name: "iPhone session actions")
    var writable = true
    var selected = true
    var replacementAllowed = true
    var calls: [String] = []
    var error: ShepherdError?
    var hold = false
    var pending: CheckedContinuation<Void, Never>?
    var branchRenamed = true
    var steered = true
    var archived = true
    var recapOK = true
    var renameName: String?
    var amendedText: String?
    var readyValue: Bool?
    var relaunchRequest: RelaunchRequest?
    var selectedReplacement: Session?
    var replacementNote: ActionNote?
    var git = try! decodeGit()
    var mergePayload: Components.Schemas.MergeConfirmation?
    var mergeMethod: MergeMethod?
    var deleteBranch: Bool?
    var noPR = false
    var freshGit: GitState?
    var listing = try! decodeLeftovers([])
    var failOnce: [String: ShepherdError] = [:]
    var archivedReap: [String]?
    var decommissioned = 0
    let merge: MergeModel
    init(merge: MergeModel? = nil) {
        self.merge = merge ?? MergeModel(reads: .init(snapshot: { MergeSnapshot() }))
    }
    lazy var rules = ActionsModel(reads: .init(recaps: { [:] }), now: { 1 })
    lazy var state = IOSSessionActionState(operations: operations, merge: merge,
        session: { self.session }, actions: { self.rules.actions(for: $0) }, git: { self.git },
        canWrite: { self.writable }, isSelected: { self.selected },
        canSelectReplacement: { self.replacementAllowed },
        decommissioned: { self.decommissioned += 1 },
        selectReplacement: { self.selectedReplacement = $0; self.replacementNote = $1 })
    var operations: IOSActionOperations {
        .init(stop: { _ in try await self.record("stop") },
            resume: { _ in try await self.record("resume") },
            ready: { _, value in self.readyValue = value; try await self.record("ready") },
            rename: { _, name in
                self.renameName = name; try await self.record("rename")
                var renamed = self.session; renamed.name = name
                return RenameResult(session: renamed, branchRenamed: self.branchRenamed)
            }, amend: { id, text, _ in
                self.amendedText = text; try await self.record("amend")
                return AmendmentCreated(amendment: .init(id: "a1", sessionId: id, text: text, createdAt: 1), steered: self.steered)
            }, relaunch: { _, request in
                self.relaunchRequest = request; try await self.record("relaunch")
                return RelaunchResult(session: PreviewData.session(id: "replacement", desig: "TASK-02"), archived: self.archived)
            }, recap: { _ in
                try await self.record("recap")
                return RecapRegenerateResult(ok: self.recapOK, status: .init(known: self.recapOK ? .started : .error))
            }, git: { _ in try await self.record("git"); return self.noPR ? nil : self.freshGit ?? self.git },
            merge: { _, method, delete, payload in
                self.mergePayload = payload; self.mergeMethod = method; self.deleteBranch = delete
                try await self.record("merge"); return self.git
            }, leftovers: { _ in try await self.record("leftovers"); return self.listing },
            closePR: { _ in try await self.record("closePR") },
            archive: { _, reap in self.archivedReap = reap; try await self.record("archive") })
    }
    func record(_ call: String) async throws {
        calls.append(call)
        if hold { await withCheckedContinuation { pending = $0 } }
        if let failure = failOnce.removeValue(forKey: call) { throw failure }
        if let error { throw error }
    }
    func release() { hold = false; pending?.resume(); pending = nil }
    static func decodeGit(handoff: String = "reviewer") throws -> GitState {
        let payload: [String: Any] = ["kind": "github", "state": "open", "checks": "success", "deployConfigured": false, "number": 42, "title": "iPhone session actions", "headSha": "fresh-head",
            "baseRefName": "develop", "mergeMethod": "squash", "mergeGate": ["handoff": handoff, "handoffWho": "alex", "reviewBlockBy": "sam"]]
        return try JSONDecoder().decode(GitState.self, from: JSONSerialization.data(withJSONObject: payload))
    }
    static func decodeLeftovers(_ keys: [String], probesUnavailable: Bool = false) throws -> ComposeLeftovers {
        let rows: [[String: Any]] = keys.enumerated().map {
            ["kind": "process", "name": "\($0.element) dev server", "port": 5173 + $0.offset, "key": $0.element]
        }
        return try JSONDecoder().decode(ComposeLeftovers.self, from: JSONSerialization.data(
            withJSONObject: ["leftovers": rows, "probesUnavailable": probesUnavailable] as [String: Any]))
    }
}
