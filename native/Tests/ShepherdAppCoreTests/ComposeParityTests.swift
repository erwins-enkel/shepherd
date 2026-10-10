import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
    @MainActor @Suite struct ComposeParityTests {
        @Test(arguments: [false, true], [false, true])
        func timelineCoversEveryToggleAndProvider(planGate: Bool, autopilot: Bool) {
            for provider in [AgentProvider.claude, .codex] {
                let timeline = GuardTimeline.derive(planGate: planGate, autopilot: autopilot, provider: provider, baseBranch: "main")
                let suffix = !autopilot ? "manual" : provider == .codex ? "auto_codex" : "auto"
                #expect(timeline.headerKey == "guardtl_head_\(planGate ? "plan" : "nogate")_\(suffix)")
                #expect(timeline.steps.map(\.id) == (planGate ? ["grill", "review", "release", "to-pr"] : ["to-pr"]))
                if planGate {
                    #expect(timeline.steps[0].kind == .human)
                    #expect(timeline.steps[1].kind == .conditional)
                }
                for step in timeline.steps where ["release", "to-pr"].contains(step.id) {
                    #expect(step.kind == (!autopilot ? .human : provider == .codex ? .conditional : .auto))
                    #expect(!step.repoScoped)
                    #expect(!GuardTimeline.copy(step.key).isEmpty)
                }
                #expect(!GuardTimeline.copy(timeline.headerKey).isEmpty)
            }
        }

        @Test func repoTimelineNeverPromisesUnconditionalPostPRWork() {
            for provider in [AgentProvider.claude, .codex] {
                for critic in [false, true] {
                    for address in [false, true] {
                        for merge in [false, true] {
                            for draft in [false, true] {
                                let repo = GuardTimeline.Repo(critic: critic, autoAddress: address, autoMerge: merge, draftMode: draft)
                                let timeline = GuardTimeline.derive(planGate: true, autopilot: true, provider: provider, baseBranch: "main", repo: repo)
                                let post = timeline.steps.filter(\.repoScoped)
                                #expect(post.count == 2 && post.allSatisfy { $0.kind != .auto })
                                #expect(post[0].key == (!critic ? "guardtl_step_critic_off" : address ? "guardtl_step_critic_auto" : "guardtl_step_critic_manual"))
                                #expect(post[1].key == (draft ? "guardtl_step_merge_you_draft" : !merge ? "guardtl_step_merge_you_automerge" : provider == .codex ? "guardtl_step_merge_train_codex" : "guardtl_step_merge_train"))
                                #expect(post.allSatisfy { !GuardTimeline.copy($0.key).isEmpty })
                            }
                        }
                    }
                }
            }
            let repo = GuardTimeline.Repo(critic: true, autoAddress: true, autoMerge: true, draftMode: false)
            for base in ["epic/42", "epic/42-feature-name"] {
                let result = GuardTimeline.derive(planGate: false, autopilot: false, provider: .codex, baseBranch: base, repo: repo)
                #expect(result.steps.last?.key == "guardtl_step_merge_you_epic")
            }
            for base in ["main", "epic/word", "epic/42-Upper"] {
                let result = GuardTimeline.derive(planGate: false, autopilot: false, provider: .claude, baseBranch: base, repo: repo)
                #expect(result.steps.last?.key == "guardtl_step_merge_you_autopilot")
            }
        }

        @Test func defaultsKeepInheritanceAndRespectTouchedFlagsAndModes() throws {
            let model = ComposeModelTests.composer()
            defer { model.teardown() }
            model.repoBranches.allowsStatusProbe = false
            model.repoPath = "/repo"; model.prompt = "Task"
            model.applyRepoGuardDefaults(planGate: true, autopilot: true)
            #expect(model.planGateEnabled && model.autopilotEnabled)
            let request = try #require(model.createRequest(baseBranch: "main"))
            #expect(request.planGateEnabled == nil && request.autopilotEnabled == nil)
            model.planGateTouched = true; model.planGateEnabled = false
            model.applyRepoGuardDefaults(planGate: true, autopilot: false)
            #expect(!model.planGateEnabled && !model.autopilotEnabled)
            for mode in [ComposeMode.research, .epic, .plain] {
                model.setMode(mode)
                model.applyRepoGuardDefaults(planGate: true, autopilot: true)
                #expect(!model.planGateEnabled && !model.autopilotEnabled)
            }
        }

        private func withApp(_ run: (AppModel) async throws -> Void) async throws {
            let suite = "ComposeHandoverTests.\(UUID())"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
                               notifications: CoreTestSupport.environment(defaults: defaults))
            app.credentialProbe = { _, _ in StoredCredential(token: "test", tokenId: "test") }
            app.health = { _ in throw ShepherdError.transport("fixture") }
            defer { app.teardown() }
            try await run(app)
        }

        @Test func serverHandoverPreservesPromptOnceAndResetsServerContext() async throws {
            try await withApp { app in
                let first = try app.addRemoteProfile(name: "A", address: "https://a.fixture.invalid")
                let second = try app.addRemoteProfile(name: "B", address: "https://b.fixture.invalid")
                await app.activate(first)
                let previous = try #require(app.store)
                app.sheet = .newSession
                let old = ComposeModel(client: previous.client, defaults: app.composerDefaults)
                defer { old.teardown() }
                old.repoBranches.allowsStatusProbe = false
                old.repoPath = "/old"; old.repoBranches.baseBranch = "old-branch"
                old.pickIssue(.init(number: 12, title: "Old", body: "Old issue", url: "https://example.com/12", labels: [], createdAt: 0, assignees: []))
                old.prompt = "Keep this\nprompt 🐑"
                let generation = app.activationGeneration
                await app.activateForCompose(second, prompt: old.prompt)
                #expect(app.activeProfile?.id == second.id && app.store !== previous)
                #expect(app.sheet == .newSession)
                #expect(app.consumeComposePrompt(activation: generation) == nil)
                let fresh = ComposeModel(client: try #require(app.store).client, defaults: app.composerDefaults)
                defer { fresh.teardown() }
                fresh.prompt = try #require(app.consumeComposePrompt(activation: app.activationGeneration))
                #expect(fresh.prompt == old.prompt)
                #expect(fresh.repoPath.isEmpty && fresh.repoBranches.baseBranch == "main" && fresh.activeIssue == nil)
                #expect(app.consumeComposePrompt(activation: app.activationGeneration) == nil)
            }
        }

        @Test func credentialRetryContinuesThePendingPrompt() async throws {
            try await withApp { app in
                let a = try app.addRemoteProfile(name: "A", address: "https://a.fixture.invalid")
                let b = try app.addRemoteProfile(name: "B", address: "https://b.fixture.invalid")
                await app.activate(a); app.sheet = .newSession
                app.credentialProbe = { _, _ in throw ShepherdError.transport("fixture") }
                await app.activateForCompose(b, prompt: "Preserve through retry")
                #expect(app.store == nil)
                #expect(app.consumeComposePrompt(activation: app.activationGeneration) == nil)
                app.credentialProbe = { _, _ in StoredCredential(token: "test", tokenId: "test") }
                await app.retryCredentialAccess()
                #expect(app.store != nil && app.sheet == .newSession)
                #expect(app.consumeComposePrompt(activation: app.activationGeneration) == "Preserve through retry")
            }
        }

        @Test func closingOrAnotherActivationDropsTheHandover() async throws {
            try await withApp { app in
                let a = try app.addRemoteProfile(name: "A", address: "https://a.fixture.invalid")
                let b = try app.addRemoteProfile(name: "B", address: "https://b.fixture.invalid")
                await app.activate(a); app.sheet = .newSession
                await app.activateForCompose(b, prompt: "Discard on close")
                app.sheet = nil
                app.sheet = .newSession
                #expect(app.consumeComposePrompt(activation: app.activationGeneration) == nil)
                await app.activateForCompose(a, prompt: "Discard on unrelated activation")
                await app.activate(b)
                #expect(app.consumeComposePrompt(activation: app.activationGeneration) == nil)
                let generation = app.activationGeneration
                await app.activateForCompose(b, prompt: "Same server")
                #expect(app.activationGeneration == generation)
            }
        }
    }
}
