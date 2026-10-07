import AppKit
import ApplicationServices
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

private struct SessionCardAXRecord: Sendable {
    let id: String
    let text: String
}

extension MacSeamTests {
@MainActor
@Suite(.serialized)
struct SessionCardRenderingTests {
    private struct Element {
        let id: String
        let text: String
        let frame: NSRect
        let object: AnyObject?
    }

    private func rendered<Content: View>(
        _ view: Content, width: CGFloat, check: ([Element], NSHostingView<Content>) throws -> Void
    ) async throws {
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: width, height: 800),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Agent card test"
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        defer { window.orderOut(nil); window.contentView = nil }
        let pid = ProcessInfo.processInfo.processIdentifier
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.25)
            var windows: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
            var visited: Set<CFHashCode> = []
            var records: [SessionCardAXRecord] = []
            let deadline = ContinuousClock.now + .seconds(10)
            func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
                var value: CFTypeRef?
                guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
                return value
            }
            func visit(_ element: AXUIElement, depth: Int = 0) {
                guard depth < 30, ContinuousClock.now < deadline,
                      visited.count < 500, visited.insert(CFHash(element)).inserted else { return }
                let text = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
                    .compactMap { attribute(element, $0) as? String }.joined(separator: " ")
                records.append(.init(id: attribute(element, kAXIdentifierAttribute) as? String ?? "", text: text))
                for name in [kAXChildrenAttribute, kAXRowsAttribute, kAXContentsAttribute] {
                    for child in attribute(element, name) as? [AXUIElement] ?? [] {
                        visit(child, depth: depth + 1)
                    }
                }
            }
            for window in windows as? [AXUIElement] ?? [] {
                if attribute(window, kAXTitleAttribute) as? String == "Agent card test" { visit(window) }
            }
            return (status.rawValue, records)
        }.value
        #expect(result.0 == AXError.success.rawValue)
        func walk(_ object: Any, depth: Int = 0) -> [Element] {
            guard depth < 60 else { return [] }
            let element = object as AnyObject
            let value: Any? = element.accessibilityValue?()
            let current = Element(id: element.accessibilityIdentifier?() ?? "",
                text: [element.accessibilityLabel?(), value as? String].compactMap { $0 }.joined(separator: " "),
                frame: element.accessibilityFrame?() ?? .zero, object: element)
            return [current] + (element.accessibilityChildren?() ?? []).flatMap { walk($0, depth: depth + 1) }
        }
        try check(walk(host) + result.1.map { Element(id: $0.id, text: $0.text, frame: .zero, object: nil) }, host)
    }

    @Test func cardShowsTaskEnvironmentAndUsableRepositoryAndDetailsControls() async throws {
        var session = PreviewData.session(name: "agent-card-content",
            prompt: "Show the task description and model directly on each agent card.")
        session.createdAt = Int(Date.now.timeIntervalSince1970 * 1_000) - 545_000
        session.runtimeModel = "gpt-6.1-sol"
        session.runtimeEffort = "xhigh"
        var filtered = false
        let view = SessionRow(session: session, onRepoFilter: { filtered = true }).padding(10)
        try await rendered(view, width: 280) { elements, _ in
            #expect(elements.contains { $0.id == "session-prompt-s1" && $0.text.contains(session.prompt) })
            #expect(elements.contains { $0.id == "session-environment-s1" && $0.text.contains("GPT-6.1 Sol") })
            #expect(elements.contains { $0.id == "session-clock-s1" })
            let repo = try #require(elements.first { $0.id == "session-repo-s1" })
            #expect(repo.object?.accessibilityPerformPress?() == true)
            #expect(filtered, "the repository control must run its own action")
        }
    }

    @Test func allBadgesRemainVisibleAtNarrowAndWideWidthsAndActionsAreSeparate() async throws {
        let badges: [SessionBadge] = [
            .init(id: "cli", text: "Codex", tint: .secondary),
            .init(id: "issue", text: "#123", tint: .secondary, url: URL(string: "https://example.invalid/issues/123")),
            .init(id: "critic", text: L.t("criticbadge_round", "2", "3"), tint: .orange),
            .init(id: "sandbox", text: L.t("session_sandbox_autonomous_label"), tint: .secondary),
            .init(id: "manual-steps", text: L.t("unitrow_manual_steps", "2"), tint: .yellow),
        ]
        for width in [CGFloat(240), 400] {
            var selected: String?
            let view = SessionBadgeStack(badges: badges, onSelect: { selected = $0 }).padding(10)
            try await rendered(view, width: width) { elements, _ in
                for badge in badges {
                    let element = try #require(elements.first { $0.id == "herd-badge-\(badge.id)" })
                    #expect(element.frame.width <= width)
                }
                let review = try #require(elements.first { $0.id == "herd-badge-critic" })
                #expect(review.object?.accessibilityPerformPress?() == true)
                #expect(selected == "critic")
                let manual = try #require(elements.first { $0.id == "herd-badge-manual-steps" })
                #expect(manual.object?.accessibilityPerformPress?() == true)
                #expect(selected == "manual-steps")
            }
        }
    }

    @Test func productionSidebarRendersRichCardsAtBothWidths() async throws {
        let suite = "SessionCardRenderingTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: MacTestSupport.environment(defaults: defaults))
        defer { app.teardown(); defaults.removePersistentDomain(forName: suite) }
        let now = Int(Date.now.timeIntervalSince1970 * 1_000)
        var coding = PreviewData.session(id: "coding", desig: "TASK-1872", name: "agent-card-content",
            prompt: "Show each agent's task, repository, runtime model and useful actions.", agentProvider: .codex)
        coding.createdAt = now - 545_000
        coding.runtimeModel = "gpt-6.1-sol"
        coding.runtimeEffort = "xhigh"
        coding.sandboxApplied = .standard
        var waiting = PreviewData.session(id: "waiting", desig: "TASK-1813", name: "review-and-merge",
            prompt: "Check the pull request and address the remaining merge conflicts.", status: .init(known: .done))
        waiting.createdAt = now - 165_600_000
        waiting.runtimeModel = "claude-opus-5-5"
        waiting.contextTokens = 150_000
        waiting.additionalProperties = try .init(unvalidatedValue: ["coldResumeAt": now - 1, "resumeCostUnits": 1.9])
        var planning = PreviewData.session(id: "planning", desig: "TASK-1871", name: "plan-review",
            prompt: "Explain why this repository's CI takes so long.", status: .init(known: .done), agentProvider: .codex)
        planning.createdAt = now - 587_000
        planning.planPhase = .init(known: .planning)
        planning.runtimeModel = "gpt-6.1-sol"
        planning.runtimeEffort = "high"
        var git = GitState(state: .init(known: .open), checks: .init(known: .success), deployConfigured: false)
        git.number = 110
        git.url = "https://example.invalid/pull/110"
        git.mergeStateStatus = .init(known: .dirty)
        let verdict = ReviewVerdict(sessionId: waiting.id, headSha: "head", decision: .init(known: .commented),
            summary: "Reviewed the current changes", body: "The task is implemented.", findings: [],
            addressRound: 0, addressCap: 3, finalRoundPending: false, finalRoundTimeoutMs: 900_000, updatedAt: now)
        let activity = SessionActivitySignal(lastActivityTs: now, summary: "Updating the native sidebar",
            recentTs: [now, now - 30_000, now - 60_000], recentErrTs: [])
        let herd = HerdSignals(reads: .stub(git: [waiting.id: git], activity: [coding.id: activity],
            verdicts: [waiting.id: verdict]), now: { now })
        let holds = [waiting.id: HoldReason(code: .init(known: .prConflict))]
        let sidebar = SidebarModel(reads: .init(workingBlocked: { [:] },
            holds: { holds }, blocks: { [:] },
            usage: { UsageLimitsResponse(limits: UsageLimits(perModelWeek: [], stale: false, subscriptionOnly: false),
                projections: []) }), now: { now })
        let plan = PlanModel(reads: .init(gates: { [:] }, inflight: { [] }))
        let actions = ActionsModel(reads: .init(recaps: { [:] }), now: { now })
        app.liveExtensions = [
            (ObjectIdentifier(HerdSignals.self), herd), (ObjectIdentifier(SidebarModel.self), sidebar),
            (ObjectIdentifier(PlanModel.self), plan), (ObjectIdentifier(ActionsModel.self), actions),
        ]
        sidebar.install(sessions: [coding, waiting, planning])
        sidebar.gitStage = { herd.stage(for: $0) }
        app.selectedSessionID = waiting.id
        await herd.refresh()
        await sidebar.refresh()
        for width in [CGFloat(280), 400] {
            try await rendered(SidebarView(model: sidebar).environment(app), width: width) { elements, host in
                let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                let available = elements.filter { $0.id.hasPrefix("session-") || $0.text == L.t("cardmenu_label") }
                    .map { $0.id + ": " + $0.text }.joined(separator: "\n")
                for id in [coding.id, waiting.id, planning.id] {
                    #expect(elements.contains { $0.id == "session-menu-\(id)" }, "Missing menu for \(id): \(available)")
                    #expect(elements.contains { $0.id == "session-prompt-\(id)" })
                    #expect(elements.contains { $0.id == "session-environment-\(id)" })
                }
                #expect(elements.contains { $0.id == "session-cold-resume-waiting" })
                #expect(elements.contains { $0.id == "plan-gate-badge-planning" })
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let image = try #require(bitmap.representation(using: .png, properties: [:]))
                try image.write(to: directory.appendingPathComponent(".build/agent-cards-\(Int(width)).png"))
            }
        }
    }
}
}
