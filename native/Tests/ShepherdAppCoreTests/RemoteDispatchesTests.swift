import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

private let macJSON = #"{"instanceId":"mac","name":"MacBook","platform":"macos"}"#
private let linuxJSON = #"{"instanceId":"linux","name":"moes-tavern","platform":"linux"}"#

private func dispatch(_ id: String = "d1", state: String = "waiting", readiness: String? = #"{"state":"offline","status":"timeout"}"#,
                      alternatives: String = "[\(linuxJSON)]", extra: String = "") throws -> RemoteDispatch {
    let placement = #"{"mode":"auto","target":\#(macJSON),"requirements":["xcode"],"basis":"requirements","preferred":null,"by":{"instanceId":"linux","name":"moes-tavern"},"decidedAt":1}"#
    return try JSONDecoder().decode(RemoteDispatch.self, from: Data(#"""
        {"id":"\#(id)","state":"\#(state)","host":\#(macJSON),"summary":"Fix the iOS build","createdAt":1,"updatedAt":2,
         "placement":\#(placement),"alternatives":\#(alternatives)\#(readiness.map { #","readiness":\#($0)"# } ?? "")\#(extra)}
        """#.utf8))
}

/// What the fake server answers next; main-actor state the reads hop to.
@MainActor
private final class Answers {
    var cancel: () throws -> RemoteDispatchCancel = { throw ShepherdError.notFound }
    var redirect: () throws -> CreateOutcome = { throw ShepherdError.notFound }
    var list: () throws -> [RemoteDispatch] = { [] }
    var redirects: [String] = []
}

/// Tasks for machines that are not settled (#2776): the four states the herd keeps apart, what
/// they mean, and cancel and redirect. Mirrors `ui/src/lib/remote-dispatches.ts`,
/// `remoteDispatchExplanation` and `RemoteDispatchRow.svelte`.
extension CoreSeamTests {
@MainActor @Suite struct RemoteDispatchesTests {
    @Test func theStatesAreToldApart() throws {
        let waiting = try dispatch()
        #expect(DispatchCopy.label(waiting) == L.t("remote_dispatch_waiting"))
        #expect(DispatchCopy.detail(waiting) == PlacementCopy.reason(try #require(waiting.placement)))
        #expect(DispatchCopy.tone(waiting) == .resolving)
        #expect(DispatchCopy.isCancelable(waiting))

        let blocked = try dispatch(readiness: #"{"state":"missing_capabilities","missing":[{"capability":"xcode","reason":"license_not_accepted"}]}"#)
        #expect(DispatchCopy.isBlocked(blocked))
        #expect(DispatchCopy.label(blocked) == L.t("remote_dispatch_blocked"))
        let lacks = "\(L.t("settings_machines_cap_xcode")) (\(L.t("settings_machines_cap_reason_license_not_accepted")))"
        #expect(DispatchCopy.detail(blocked) == L.t("remote_dispatch_missing_detail", lacks))
        #expect(DispatchCopy.tone(blocked) == .blocked)

        let held = try dispatch(state: "held", readiness: nil)
        #expect(DispatchCopy.label(held) == L.t("remote_dispatch_held"))
        #expect(DispatchCopy.detail(held) == L.t("remote_dispatch_held_detail"))
        #expect(DispatchCopy.tone(held) == .settling)
        #expect(DispatchCopy.explanation(held).title == L.t("tooltip_held_title", "MacBook"))

        let unknown = try dispatch(state: "unknown", readiness: nil)
        #expect(DispatchCopy.label(unknown) == L.t("remote_dispatch_unknown"))
        #expect(DispatchCopy.detail(unknown) == nil)
        #expect(DispatchCopy.isCancelable(unknown))
        let canceling = try dispatch(state: "canceling", readiness: nil)
        #expect(DispatchCopy.label(canceling) == L.t("remote_dispatch_canceling"))
        #expect(!DispatchCopy.isCancelable(canceling))
        #expect(!DispatchCopy.isShown(try dispatch(state: "started")))
    }

    @Test func theExplanationSaysWhenItStartsAndThatNothingFallsBack() throws {
        let waiting = DispatchCopy.explanation(try dispatch())
        #expect(waiting.title == L.t("tooltip_waiting_title", "MacBook"))
        #expect(waiting.sections.map(\.label) == [L.t("tooltip_waiting_connection"), L.t("tooltip_waiting_start"),
                                                  L.t("tooltip_waiting_fallback"), L.t("tooltip_dispatch_cancel")])
        #expect(waiting.sections[0].text == L.t("settings_machines_status_unreachable"))
        #expect(waiting.sections[2].text == L.t("tooltip_waiting_fallback_body", "moes-tavern"))
        let ready = DispatchCopy.explanation(try dispatch(readiness: #"{"state":"ready"}"#, alternatives: "[]"))
        #expect(ready.summary == L.t("tooltip_waiting_ready_summary", "MacBook"))
        #expect(ready.sections.first?.label == L.t("tooltip_waiting_start"), "back: no connection to explain")
        #expect(ready.sections[1].text == L.t("tooltip_waiting_fallback_none"))
        let blocked = DispatchCopy.explanation(try dispatch(readiness: #"{"state":"project_missing"}"#))
        #expect(blocked.title == L.t("tooltip_blocked_title", "MacBook"))
        #expect(blocked.summary == L.t("tooltip_blocked_project_summary", "MacBook"))
        #expect(DispatchCopy.explanation(try dispatch(state: "unknown", readiness: nil)).title == L.t("remote_dispatch_unknown"))
    }

    @Test func aFrameUpdatesTheListAndAResolvedTaskSaysHowItEnded() throws {
        let model = RemoteDispatchesModel(reads: .init(list: { [] }, cancel: { _ in throw ShepherdError.notFound },
                                                       redirect: { _, _ in throw ShepherdError.notFound }))
        model.apply(try dispatch())
        model.apply(try dispatch("d2", state: "unknown", readiness: nil))
        #expect(model.dispatches.map(\.id) == ["d1", "d2"])
        model.apply(try dispatch(readiness: #"{"state":"ready"}"#))
        #expect(model.dispatches.first?.readiness?.state.rawValue == "ready")
        model.apply(try dispatch("d9", state: "started", readiness: nil))
        #expect(model.notice == nil, "a task that was never shown changes nothing")
        model.apply(try dispatch(state: "started", readiness: nil, extra: #","sessionId":"s1""#))
        #expect(model.dispatches.map(\.id) == ["d2"])
        #expect(model.notice == .init(text: L.t("toast_dispatch_started_on", "MacBook"), alert: false))
        model.apply(try dispatch("d2", state: "rejected", readiness: nil, extra: #","reason":"no Xcode""#))
        #expect(model.dispatches.isEmpty)
        #expect(model.notice == .init(text: L.t("toast_dispatch_declined_on", "MacBook", "no Xcode"), alert: true))
    }

    @Test func cancelAndRedirectSayWhatHappened() async throws {
        let answers = Answers()
        answers.cancel = { .canceled(try dispatch(state: "canceled", readiness: nil)) }
        answers.redirect = { .created(PreviewData.session(id: "s")) }
        let model = RemoteDispatchesModel(reads: .init(
            list: { [] },
            cancel: { _ in try await MainActor.run { try answers.cancel() } },
            redirect: { _, to in try await MainActor.run { answers.redirects.append(to); return try answers.redirect() } }))
        let waiting = try dispatch()
        model.apply(waiting)
        await model.cancel(waiting)
        #expect(model.dispatches.isEmpty)
        #expect(model.notice == .init(text: L.t("toast_dispatch_canceled_on", "MacBook"), alert: false))

        model.apply(waiting)
        answers.cancel = { .pending(try dispatch(state: "canceling", readiness: nil)) }
        await model.cancel(waiting)
        #expect(model.dispatches.first?.state.rawValue == "canceling")
        #expect(model.notice == .init(text: L.t("toast_dispatch_cancel_pending", "MacBook"), alert: false))

        answers.cancel = { throw RemoteDispatchConflict(code: "remote_dispatch_not_cancelable", dispatch: nil) }
        await model.cancel(waiting)
        #expect(model.notice == .init(text: L.t("toast_dispatch_not_cancelable", "MacBook"), alert: true))

        let linux: SessionHost = try JSONDecoder().decode(SessionHost.self, from: Data(linuxJSON.utf8))
        await model.redirect(waiting, to: linux)
        #expect(answers.redirects == ["linux"])
        #expect(model.notice == .init(text: L.t("toast_dispatch_started_on", "moes-tavern"), alert: false))
        answers.redirect = { throw MachineRefusal(code: "missing_capabilities", host: linux, missing: [.init(capability: "xcode", reason: "not_installed")]) }
        await model.redirect(waiting, to: linux)
        #expect(model.notice?.alert == true)
        #expect(model.notice?.text == PlacementCopy.failure(
            MachineRefusal(code: "missing_capabilities", host: linux, missing: [.init(capability: "xcode", reason: "not_installed")]),
            machine: "moes-tavern"))

        let readOnly = RemoteDispatchesModel(reads: .init(list: { [] }, cancel: { _ in
            Issue.record("a read-only launch never cancels"); throw ShepherdError.cancelled
        }, redirect: { _, _ in throw ShepherdError.cancelled }), actionsAllowed: false)
        await readOnly.cancel(waiting)
    }

    @Test func aReadShowsOnlyWhatIsNotSettledAndAnOldServerListsNothing() async throws {
        let listed = [try dispatch(), try dispatch("d2", state: "started", readiness: nil)]
        let answers = Answers()
        answers.list = { listed }
        let model = RemoteDispatchesModel(reads: .init(
            list: { try await MainActor.run { try answers.list() } },
            cancel: { _ in throw ShepherdError.notFound }, redirect: { _, _ in throw ShepherdError.notFound }))
        await model.refresh()
        #expect(model.dispatches.map(\.id) == ["d1"])
        answers.list = { throw ShepherdError.notFound }
        await model.refresh()
        #expect(model.dispatches.isEmpty)
    }

    @Test func aMachineWithOnlyWaitingTasksGetsItsOwnGroup() throws {
        var session = PreviewData.session(id: "r")
        session.host = try JSONDecoder().decode(SessionHost.self, from: Data(linuxJSON.utf8))
        session.connection = SessionConnection(state: .init(known: .connected), since: 1)
        let groups = HerdMachineGroup.groups([session], dispatches: [try dispatch()])
        #expect(groups.map(\.id) == ["linux", "mac"])
        #expect(groups[1].connection == nil)
        #expect(groups[1].dispatches.map(\.id) == ["d1"])
        #expect(groups[0].dispatches.isEmpty)

        let sidebar = SidebarModel(reads: .stub, now: { 1_800_000_000_000 })
        let local = PreviewData.session(id: "local")
        sidebar.install(sessions: [local])
        sidebar.install(remoteDispatches: [try dispatch()])
        #expect(sidebar.machineGroups.map(\.id) == ["mac"])
        sidebar.selectedRepos = [local.repoPath]
        #expect(sidebar.machineGroups.isEmpty, "a repo filter narrows the herd to this server's work")
    }
}
}
