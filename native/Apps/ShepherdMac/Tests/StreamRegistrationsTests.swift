import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
@Suite(.serialized)
struct StreamRegistrationsTests {
    init() { resetStreamSeams() }

    @Test func sidebarPlusRoutesThroughTheInstalledComposer() {
        defer { resetStreamSeams() }
        let app = scratchModel()
        defer { app.teardown() }
        StreamRegistrations.installAll(into: app)
        MainWindow.openComposer(app)
        #expect(app.sheet == .newSession)
        #expect(NewSessionSlot.resolution == .slot)
        #expect(NewSessionSlot.content?(app) != nil)
    }

    @Test func isolatedLiveLaunchDisablesWritesBeforeInstallingStreams() throws {
        defer { resetStreamSeams() }
        let launch = IsolatedLaunch(configuration: .init(
            isIsolated: true,
            live: .init(baseURL: "https://integration.invalid", password: "fixture")))
        let app = launch.makeModel()
        defer { app.teardown() }
        // Never start the seed: this checks production setup with fixture credentials only.
        #expect(!app.allowsQueueRecomputation)
        #expect(!app.allowsTerminalInput)
        StreamRegistrations.installAll(into: app)
        let profile = ServerProfile(name: "integration", baseURL: URL(string: "https://integration.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        app.makeExtensions(store: store)
        let terminal = try #require(app.extension(TerminalController.self))
        #expect(!terminal.model(for: "a").allowsInput)
    }

    @Test func productionPassesInstallAndResetEveryRegistry() {
        defer { resetStreamSeams() }
        let app = scratchModel()
        defer { app.teardown() }
        StreamRegistrations.installScene()
        for lens in [HerdLens.next, .owed, .done] {
            #expect(QueuesPanels.panel(for: lens) != nil)
        }
        StreamRegistrations.installAll(into: app)
        let factories = Set(app.extensionFactories.map(\.key))
        for type in [HerdSignals.self, PlanModel.self, QueuesModel.self, MergeModel.self] as [any AppExtension.Type] {
            #expect(factories.contains(ObjectIdentifier(type)))
        }
        #expect(DetailTabRegistry.tabs.map(\.id).contains("plan"))
        #expect(DetailTabRegistry.tabs.map(\.id).contains("merge"))
        #expect(NewSessionSlot.resolution == .slot)
        #expect(CommandRegistry.commands(in: .session).contains { $0.id == "merge.overview" })
        #expect(SidebarSlot.content != nil)
        #expect(ActionBarSlot.content != nil)
        #expect(WelcomeSlots.localPanel != nil)
        // Poison the closures: with no active model the installed closures already return
        // false, so merely checking false after reset would not test the reset at all.
        PlanSignals.planReviewing = { _ in true }
        SessionSignals.planQuestionsUnanswered = { _ in true }
        SessionSignals.gitMerged = { _ in true }
        SessionSignals.workingBlocked = { ["a": true] }
        SessionSignals.manualStepsOutstanding = { ["a": 1] }
        MergeInputs.git = { _ in ["a": .init(state: .init(known: .open), checks: .init(known: .success), deployConfigured: false)] }
        MergeInputs.reviewing = { _, _ in true }
        MergeInputs.planReviewBlocked = { _, _ in false }
        MergeInputs.terminalEnded = { _, _ in false }
        resetStreamSeams()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
        #expect(SidebarSlot.content == nil)
        #expect(ActionBarSlot.content == nil)
        #expect(WelcomeSlots.localPanel == nil)
        #expect(!PlanSignals.planReviewing("a"))
        #expect(!SessionSignals.planQuestionsUnanswered("a"))
        #expect(!SessionSignals.gitMerged("a"))
        #expect(SessionSignals.workingBlocked().isEmpty)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
        #expect(NewSessionSlot.resolution == .fallback)
        #expect(MergeInputs.git(app).isEmpty)
        #expect(!MergeInputs.reviewing(app, "a"))
        #expect(MergeInputs.planReviewBlocked(app, "a"))
        #expect(MergeInputs.terminalEnded(app, "a"))
        for lens in [HerdLens.next, .owed, .done] {
            #expect(QueuesPanels.panel(for: lens) == nil)
        }
        // A reset must also re-arm the once-only scene pass.
        StreamRegistrations.installScene()
        #expect(QueuesPanels.panel(for: .next) != nil)
    }

    @Test func productionSignalsFollowEveryActivationAndTearDown() async throws {
        defer { resetStreamSeams() }
        let app = scratchModel()
        defer { app.teardown() }
        StreamRegistrations.installAll(into: app)
        let profile = ServerProfile(name: "integration", baseURL: URL(string: "https://integration.invalid")!, mode: .remote)
        var session = PreviewData.session(id: "a", status: .init(known: .running))
        session.planPhase = .init(known: .planning)
        for _ in 0..<2 {
            let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
            app.makeExtensions(store: store)
            let herd = try #require(app.extension(HerdSignals.self))
            let plan = try #require(app.extension(PlanModel.self))
            let sidebar = try #require(app.extension(SidebarModel.self))
            let notifications = try #require(app.extension(NotificationsModel.self))
            herd.reads = .stub()
            plan.reads = .init(gates: { [:] }, inflight: { [] })
            // A gate push supersedes any bootstrap snapshot already in flight.
            let form = VisualBlockQuestionForm(_type: .questionForm, id: "form", questions: [
                .init(id: "q", prompt: "Proceed?", kind: .init(known: .freeform)),
            ])
            let gate = PlanGate(sessionId: "a", planHash: "hash", decision: .init(known: .changesRequested),
                                summary: "Questions", body: "", findings: [], round: 1, cap: 3,
                                approved: false, plan: "", blocks: [.init(value13: form)], updatedAt: 1)
            // Let scheduled bootstrap tasks finish before injecting authoritative events.
            for _ in 0..<100 { await Task.yield() }
            plan.receive(.unknown(name: "session:plangate", payload: try JSONEncoder().encode(
                SessionPlanGateEvent(id: "a", gate: gate))))
            #expect(SessionSignals.planQuestionsUnanswered("a"))
            #expect(MergeInputs.planReviewBlocked(app, "a"))
            herd.applyForTesting(name: "session:claude-alive", payload: ["id": "a", "claudeAlive": false, "liveness": "stranded"])
            #expect(MergeInputs.terminalEnded(app, "a"))
            herd.applyForTesting(name: "session:claude-alive", payload: ["id": "a", "claudeAlive": true, "liveness": "alive"])
            #expect(!MergeInputs.terminalEnded(app, "a"))
            #expect(herd.planRework(session))
            #expect(sidebar.gitStage(session) == .reworkRunning)
            plan.receive(.unknown(name: "session:plangate-reviewing", payload: try JSONEncoder().encode(
                SessionPlanGateReviewingEvent(id: "a", reviewing: true))))
            #expect(PlanSignals.planReviewing("a"))
            #expect(sidebar.inReview(session))
            herd.applyForTesting(name: "session:git", payload: [
                "id": "ci", "git": ["state": "open", "checks": "failure", "deployConfigured": false],
            ])
            #expect(await settle(until: { notifications.extraAttention == ["a", "ci"] }))
            herd.applyForTesting(name: "session:git", payload: [
                "id": "ci", "git": ["state": "merged", "checks": "success", "deployConfigured": false],
            ])
            #expect(SessionSignals.gitMerged("ci"))
            #expect(await settle(until: { notifications.extraAttention == ["a"] }))
            app.teardown()
            #expect(notifications.extraAttention.isEmpty)
            #expect(!SessionSignals.gitMerged("ci"))
            #expect(!SessionSignals.planQuestionsUnanswered("a"))
            #expect(!PlanSignals.planReviewing("a"))
            #expect(sidebar.gitStage(session) == nil)
            #expect(!sidebar.inReview(session))
            #expect(!herd.planRework(session))
            #expect(!herd.planReviewing(session))
        }
    }

    @Test func mergeSeamsResolveCurrentActivationAndKeepDefaultsBeforeBootstrap() async throws {
        defer { resetStreamSeams() }
        let app = scratchModel()
        defer { app.teardown() }
        StreamRegistrations.installAll(into: app)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
        #expect(MergeInputs.git(app).isEmpty)
        #expect(!MergeInputs.reviewing(app, "gone"))
        #expect(MergeInputs.planReviewBlocked(app, "gone"))
        #expect(MergeInputs.terminalEnded(app, "gone"))
        let owed = try JSONDecoder().decode(PostMergeSteps.self, from: Data(#"{"sessionId":"gone","desig":"TASK-1","repoPath":"/a","prNumber":7,"prTitle":"Ship","steps":[{"id":"one","text":"Check","postMerge":true,"doneAt":null}],"trackingIssueUrl":null,"trackingIssueNumber":null,"createdAt":1,"updatedAt":1,"clearedAt":null}"#.utf8))
        for count in [1, 0] {
            let merge = MergeModel(reads: .init(snapshot: { .init(owed: count == 1 ? [owed] : []) }))
            app.liveExtensions = [(ObjectIdentifier(MergeModel.self), merge)]
            await merge.refresh()
            #expect(SessionSignals.manualStepsOutstanding() == (count == 1 ? ["gone": 1] : [:]))
            app.tearDownExtensions()
            #expect(SessionSignals.manualStepsOutstanding().isEmpty)
        }
    }

    private func settle(until condition: () -> Bool) async -> Bool {
        for _ in 0..<1_000 {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }

    private struct ProbePane: SettingsPane {
        let id = "probe"
        let order = 0
        var title: String { L.t("common_close") }
        var systemImage: String { "gear" }
        func makeView(app: AppModel) -> AnyView { AnyView(EmptyView()) }
    }

    @Test func sharedResetClearsBothSceneRegistries() {
        CommandRegistry.register(.init(
            id: "probe", menu: .session, order: 0, titleKey: "common_close"
        ) { _ in })
        SettingsPaneRegistry.register(ProbePane())
        #expect(CommandRegistry.commands(in: .session).count == 1)
        #expect(SettingsPaneRegistry.panes.count == 1)

        resetStreamSeams()

        #expect(MenuCommand.Menu.allCases.allSatisfy { CommandRegistry.commands(in: $0).isEmpty })
        #expect(SettingsPaneRegistry.panes.isEmpty)
    }

    private func scratchModel() -> AppModel {
        // Never a bare `AppModel()` — its default credential store is the real Keychain.
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func sceneInstallersRunOnceBeforeEveryModelPass() {
        var events: [String] = []
        let passes = StreamRegistrations.Installation(
            scene: { events.append("scene") },
            model: { _ in
                #expect(events.filter { $0 == "scene" }.count == 1)
                #expect(events.first == "scene")
                events.append("model")
            })

        passes.installScene()
        passes.installScene()
        let app = scratchModel()
        passes.installAll(into: app)
        passes.installScene()
        passes.installAll(into: app)

        #expect(events == ["scene", "model", "model"])
    }

    @Test func modelPassCannotRunBeforeSceneInstallers() {
        var events: [String] = []
        let passes = StreamRegistrations.Installation(
            scene: { events.append("scene") },
            model: { _ in
                #expect(events == ["scene"])
                events.append("model")
            })

        passes.installAll(into: scratchModel())
        passes.installScene()

        #expect(events == ["scene", "model"])
    }

    /// Late writes are unsupported: these non-observable registries cannot invalidate a scene
    /// already built from its early reads. A later dictionary entry is not scene registration.
    @Test func modelOnlyRegistrationMissesTheSceneTimeRead() {
        let passes = StreamRegistrations.Installation(
            scene: {},
            model: { _ in
                CommandRegistry.register(.init(
                    id: "late", menu: .session, order: 0, titleKey: "common_close"
                ) { _ in })
                SettingsPaneRegistry.register(ProbePane())
            })

        passes.installScene()
        let sceneCommands = CommandRegistry.commands(in: .session)
        let scenePanes = SettingsPaneRegistry.panes
        passes.installAll(into: scratchModel())

        #expect(sceneCommands.isEmpty)
        #expect(scenePanes.isEmpty)
        #expect(CommandRegistry.commands(in: .session).map(\.id) == ["late"])
        #expect(SettingsPaneRegistry.panes.map(\.id) == ["probe"])
        resetStreamSeams()
    }
}
