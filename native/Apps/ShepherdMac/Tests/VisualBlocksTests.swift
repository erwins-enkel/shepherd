import AppKit
import ApplicationServices
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@Suite(.serialized)
@MainActor
struct VisualBlocksTests {
    private struct Element {
        let id: String
        let text: String
        let role: NSAccessibility.Role?
    }

    private func block(_ json: String) throws -> VisualBlock {
        try JSONDecoder().decode(VisualBlock.self, from: Data(json.utf8))
    }

    /// Inspect the real hosted SwiftUI accessibility tree, not a parallel presentation model.
    private func rendered(_ blocks: [VisualBlock], inferred: Bool = false) async -> [Element] {
        await renderedView(VisualBlocksView(blocks: blocks, inferred: inferred))
    }

    private func renderedView<Content: View>(_ view: Content) async -> [Element] {
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 2400),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        defer { window.orderOut(nil); window.contentView = nil }
        // SwiftUI materializes its lazy AX tree only after an accessibility client request.
        // Query our own process off MainActor so AppKit can answer; never request permissions.
        let processID = ProcessInfo.processInfo.processIdentifier
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(processID)
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows).rawValue
        }.value
        #expect(result == AXError.success.rawValue)

        func walk(_ object: Any, depth: Int = 0) -> [Element] {
            guard depth < 60 else { return [] }
            let element = object as AnyObject
            let value: Any? = element.accessibilityValue?()
            let current = Element(
                id: element.accessibilityIdentifier?() ?? "",
                text: [element.accessibilityLabel?(), value as? String]
                    .compactMap { $0 }.joined(separator: " "),
                role: element.accessibilityRole?())
            return [current] + (element.accessibilityChildren?() ?? []).flatMap { walk($0, depth: depth + 1) }
        }
        return walk(host)
    }

    private func assertBlock(_ json: String, type: String, text: [String]) async throws {
        let elements = await rendered([try block(json)])
        #expect(elements.contains { $0.id == "visual-block-\(type)-b" })
        let content = elements.map(\.text).joined(separator: "\n")
        for value in text { #expect(content.contains(value), "Missing text: \(value); got \(content)") }
    }

    @Test func richTextRendersMarkdown() async throws {
        try await assertBlock(#"{"type":"rich-text","id":"b","markdown":"A **bold** plan"}"#,
                        type: "rich-text", text: ["A bold plan"])
    }

    @Test func markdownPreservesSeparateHeadingParagraphsAndListItems() async throws {
        let elements = await rendered([try block(##"{"type":"rich-text","id":"b","markdown":"# Deployment\n\nFirst **paragraph**.\n\nSecond paragraph.\n\n- Stop server\n- Deploy"}"##)])
        #expect(elements.contains { $0.text.contains("Deployment") && !$0.text.contains("First paragraph.") })
        for text in ["First paragraph.", "Second paragraph.", "Stop server", "Deploy"] {
            #expect(elements.contains { $0.text == text }, "Missing separate block: \(text)")
        }
    }

    @Test func markdownSlicesKeepInlineFormattingAndNestedListMarkers() {
        let blocks = PlanMarkdownView.blocks("# Deploy\n\nA **bold** paragraph.\n\n1. First\n   - Nested\n2. Second")
        #expect(blocks.map { String($0.text.characters) } == ["Deploy", "A bold paragraph.", "First", "Nested", "Second"])
        #expect(blocks.first?.heading == true)
        #expect(blocks[1].text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(blocks.map(\.marker) == [nil, nil, "1.", "•", "2."])
    }

    @Test func deferredAnnotationsPreserveLabelsAndSafetyInstructions() async throws {
        for type in ["diff", "annotated-code"] {
            try await assertBlock("""
                {"type":"\(type)","id":"b","path":"key.swift","summary":"Rotate key",
                 "filename":"key.swift","annotations":[{"label":"Migration",
                 "note":"Revoke the old key only after clients migrate"},{"note":"Keep the rollback key"}]}
                """, type: type, text: ["Migration", "Revoke the old key only after clients migrate",
                                         "Keep the rollback key"])
        }
    }

    @Test func calloutRendersEveryToneAndAnOpenTone() async throws {
        let tones: [(String, StaticString)] = [
            ("info", "vblock_callout_info"), ("decision", "vblock_callout_decision"),
            ("risk", "vblock_callout_risk"), ("warning", "vblock_callout_warning"),
            ("success", "vblock_callout_success"),
        ]
        for (tone, key) in tones {
            try await assertBlock("{\"type\":\"callout\",\"id\":\"b\",\"tone\":\"\(tone)\",\"markdown\":\"A **warning**\"}",
                            type: "callout", text: [L.t(key).uppercased(), "A warning"])
        }
        try await assertBlock(#"{"type":"callout","id":"b","tone":"future-tone","markdown":"Still visible"}"#,
                        type: "callout", text: ["FUTURE-TONE", "Still visible"])
    }

    @Test func checklistIsStaticAndPreservesAllThreeStates() async throws {
        let json = #"{"type":"checklist","id":"b","items":[{"id":"done","label":"Finished","checked":true},{"id":"open","label":"Pending","checked":false},{"id":"unset","label":"Unspecified","note":"No status supplied"}]}"#
        try await assertBlock(json, type: "checklist", text: ["☑", "☐", "Finished", "Pending", "Unspecified", "No status supplied"])
        let elements = await rendered([try block(json)])
        #expect(!elements.contains { $0.role == .checkBox || $0.role == .button })
    }

    @Test func fileTreeRendersDirectoriesAndChangeBadges() async throws {
        try await assertBlock(#"{"type":"file-tree","id":"b","title":"Files","entries":[{"path":"src/a.swift","change":"added","note":"New"},{"path":"src/nested/b.swift","change":"modified"},{"path":"old.swift","change":"removed"},{"path":"renamed.swift","change":"renamed"}]}"#,
                        type: "file-tree", text: ["Files", "src", "nested", "a.swift", "b.swift", "old.swift", "renamed.swift", "New", "A", "M", "D", "R"])
    }

    @Test func treeGroupsInterleavedPathsAndIndentsTwelvePoints() {
        let rows = VisualFileTree.rows([
            .init(path: "src/a.swift", change: .init(known: .added)),
            .init(path: "README.md", change: .init(known: .modified)),
            .init(path: "/src/nested/b.swift", change: .init(known: .removed)),
            .init(path: "src/c.swift", change: .init(known: .renamed)),
            .init(path: "///", change: .init(known: .added)),
        ])
        #expect(rows.map(\.name) == ["src", "a.swift", "nested", "b.swift", "c.swift", "README.md"])
        #expect(rows.map(\.indent) == [0, 12, 12, 24, 12, 0])
    }

    @Test func tableRendersHeaderAndEveryCellIncludingRaggedRows() async throws {
        try await assertBlock(#"{"type":"table","id":"b","columns":["Name","State"],"rows":[["Alpha","Ready"],["Beta"],["Gamma","Done","Extra"]]}"#,
                        type: "table", text: ["Name", "State", "Alpha", "Ready", "Beta", "Gamma", "Done", "Extra"])
    }

    @Test func deferredTypesPreserveTheirOwnText() async throws {
        let cases: [(String, String, [String])] = [
            (#"{"type":"diff","id":"b","path":"a.swift","summary":"Change summary"}"#, "diff", ["Change summary"]),
            (#"{"type":"code","id":"b","filename":"code.swift","code":"secret source"}"#, "code", ["code.swift"]),
            (#"{"type":"annotated-code","id":"b","filename":"annotated.swift"}"#, "annotated-code", ["annotated.swift"]),
            (#"{"type":"data-model","id":"b","entities":[{"id":"user","name":"User","fields":[]}]}"#, "data-model", ["User"]),
            (#"{"type":"api-endpoint","id":"b","method":"GET","path":"/api/items","summary":"List items"}"#, "api-endpoint", ["GET /api/items", "List items"]),
            (#"{"type":"mermaid","id":"b","source":"graph TD","caption":"Architecture"}"#, "mermaid", ["Architecture"]),
        ]
        for (json, type, content) in cases {
            try await assertBlock(json, type: type, text: content + [L.t("vblock_native_not_rendered")])
        }
    }

    @Test func wireframeShowsCaptionAndOmissionNeverHTML() async throws {
        let json = #"{"type":"wireframe","id":"b","surface":"browser","html":"<script>SECRET_HTML</script><h1>Unsafe heading</h1>","caption":"Settings preview"}"#
        try await assertBlock(json, type: "wireframe", text: ["Settings preview", L.t("vblock_native_wireframe_omitted")])
        let content = await rendered([try block(json)]).map(\.text).joined()
        #expect(!content.contains("SECRET_HTML"))
        #expect(!content.contains("Unsafe heading"))
    }

    @Test func unknownTypeRendersNothingEvenWithMarkdown() async throws {
        let elements = await rendered([try block(#"{"type":"future-block","markdown":"Do not show me"}"#)])
        #expect(!elements.contains { $0.id.hasPrefix("visual-block-") })
        #expect(!elements.contains { $0.text.contains("Do not show me") })
    }

    @Test func mixedListPreservesKnownMembersInWireOrderIncludingRepeatedIDs() async throws {
        let blocks = try [
            #"{"type":"table","id":"same","columns":["Header"],"rows":[["Cell"]]}"#,
            #"{"type":"future-block","markdown":"Invisible"}"#,
            #"{"type":"rich-text","id":"same","markdown":"Middle"}"#,
            #"{"type":"callout","id":"b","tone":"info","markdown":"Info"}"#,
            #"{"type":"file-tree","id":"b","entries":[{"path":"a","change":"added"}]}"#,
            #"{"type":"checklist","id":"b","items":[{"id":"i","label":"Check"}]}"#,
            #"{"type":"question-form","id":"b","questions":[{"id":"q","prompt":"Question","kind":"freeform"}]}"#,
            #"{"type":"code","id":"b","filename":"a.swift"}"#,
            #"{"type":"annotated-code","id":"b","filename":"b.swift"}"#,
            #"{"type":"data-model","id":"b","entities":[]}"#,
            #"{"type":"api-endpoint","id":"b","method":"GET","path":"/items"}"#,
            #"{"type":"mermaid","id":"b","source":"graph TD"}"#,
            #"{"type":"wireframe","id":"b","surface":"browser","html":"<b>unsafe</b>"}"#,
            #"{"type":"diff","id":"last","path":"a","summary":"Last"}"#,
        ].map(block)
        let identifiers = await rendered(blocks).map(\.id).filter { $0.hasPrefix("visual-block-") }
        #expect(identifiers == [
            "visual-block-table-same", "visual-block-rich-text-same", "visual-block-callout-b",
            "visual-block-file-tree-b", "visual-block-checklist-b", "visual-block-question-form-b",
            "visual-block-code-b", "visual-block-annotated-code-b", "visual-block-data-model-b",
            "visual-block-api-endpoint-b", "visual-block-mermaid-b", "visual-block-wireframe-b",
            "visual-block-diff-last",
        ])
    }

    @Test(arguments: [false, true])
    func planTabRendersEnvironmentVerdictFindingsAndEligibleControls(withBlocks: Bool) async throws {
        var session = PreviewData.session(id: "s1")
        session.planPhase = .init(known: .planning)
        var gate = PlanGate(sessionId: "s1", planHash: "hash", decision: .init(known: .approved),
                            summary: "Ready verdict", body: "Reviewer prose", findings: ["Keep rollback key"],
                            round: 1, cap: 3, approved: true, plan: "# Deployment", updatedAt: 1)
        if withBlocks {
            gate.blocks = [.init(value13: .init(_type: .questionForm, id: "form", questions: [
                .init(id: "q", prompt: "Which deployment region?", kind: .init(known: .freeform)),
            ]))]
        }
        let snapshot = gate
        let model = PlanModel(reads: .init(gates: { ["s1": snapshot] }, inflight: { [] }))
        await model.refresh()
        let writer = PlanTabWriter(review: { _ in .init(ok: true, status: .init(known: .skipped)) },
                                   release: { _ in true }, quota: { _, _ in .init(ok: false, status: .init(known: .notStalled)) })
        let actions = PlanTabActions(session: session, model: model, writer: writer)
        defer { actions.teardown(); model.teardown() }
        let elements = await renderedView(PlanTabBody(actions: actions))
        let text = elements.map(\.text).joined(separator: "\n")
        for value in ["Deployment", "Ready verdict", "Reviewer prose", "Keep rollback key", L.t("planpanel_env_plan")] {
            #expect(text.contains(value))
        }
        if withBlocks { #expect(text.contains("Which deployment region?")) }
        #expect(elements.contains { $0.id == "plan-go" })
        #expect(elements.contains { $0.id == "plan-review" })
        actions.requestConfirmation()
        await actions.release()
        let released = await renderedView(PlanTabBody(actions: actions))
        #expect(!released.contains { $0.id == "plan-go" || $0.id == "plan-review" })
        #expect(released.contains { $0.text.contains(L.t("planpanel_status_view")) })
    }

    @Test func planBadgeReflectsChipAndDenseExecutionSuppression() async {
        var session = PreviewData.session(id: "s1")
        session.planPhase = .init(known: .planning)
        let gate = PlanGate(sessionId: "s1", planHash: "hash", decision: .init(known: .approved),
                            summary: "Approved", body: "", findings: [], round: 1, cap: 3,
                            approved: true, plan: "Plan", updatedAt: 1)
        let model = PlanModel(reads: .init(gates: { ["s1": gate] }, inflight: { [] }))
        await model.refresh()
        defer { model.teardown() }
        let ready = await renderedView(PlanGateBadgeView(session: session, model: model))
        #expect(ready.contains { $0.text.contains(L.t("plangate_ready")) })
        session.planPhase = .init(known: .executing)
        let dense = await renderedView(PlanGateBadgeView(session: session, model: model, allowView: false))
        #expect(!dense.contains { $0.id == "plan-gate-badge-s1" })
    }

    @Test func inferredBadgeIsOptInForRecaps() async throws {
        let mermaid = try block(#"{"type":"mermaid","id":"b","source":"graph TD","caption":"Diagram","inferred":true}"#)
        #expect(!(await rendered([mermaid])).contains { $0.text.contains(L.t("vblock_inferred")) })
        #expect((await rendered([mermaid], inferred: true)).contains { $0.text.contains(L.t("vblock_inferred")) })
    }
}
