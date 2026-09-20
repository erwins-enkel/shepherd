import Foundation
import Observation
import ShepherdKit
import SwiftUI

@Observable
@MainActor
final class DoneUsageState {
    private final class Request {
        var alive = true
    }

    private var request: Request?
    private(set) var usage: Components.Schemas.SessionUsage?

    var display: String {
        guard let usage, usage.available else { return "—" }
        return usage.total.formatted()
    }

    func load(id: String, read: (String) async throws -> Components.Schemas.SessionUsage) async {
        close()
        let mine = Request()
        request = mine
        let result = try? await read(id)
        // Cancellation alone cannot fence a transport that completes after row selection changes.
        guard mine.alive, !Task.isCancelled else { return }
        usage = result
    }

    func close() {
        request?.alive = false
        request = nil
        usage = nil
    }
}

struct DoneRestoreConfirmation {
    private(set) var armedUntil: Int?
    var isArmed: Bool { armedUntil != nil }

    mutating func tap(now: Int) -> Bool {
        if let armedUntil, now < armedUntil {
            disarm()
            return true
        }
        armedUntil = now + 3_000
        return false
    }

    mutating func disarm() { armedUntil = nil }
}

enum DoneMarkdown {
    static func render(_ markdown: String) -> AttributedString {
        guard let parsed = try? AttributedString(markdown: markdown) else {
            return AttributedString(markdown)
        }
        var result = AttributedString()
        // Foundation records block boundaries as presentation intents, removing their
        // newlines. Text handles inline emphasis/links, but needs explicit block separators.
        for (intent, range) in parsed.runs[\.presentationIntent] {
            if !result.characters.isEmpty { result.append(AttributedString("\n\n")) }
            var block = AttributedString(parsed[range])
            let components = intent?.components ?? []
            for component in components {
                switch component.kind {
                case .header: block.font = .headline
                case .codeBlock: block.font = .body.monospaced()
                case .listItem(let ordinal):
                    let unordered = components.contains { $0.kind == .unorderedList }
                    result.append(AttributedString(unordered ? "• " : "\(ordinal). "))
                default: break
                }
            }
            result.append(block)
        }
        return result
    }
}

struct DoneRecapView: View {
    let session: Session
    let recap: Recap?
    let loadUsage: (String) async throws -> Components.Schemas.SessionUsage
    // Task 8 supplies the restore action over POST /api/sessions/{id}/restore.
    // Until that wrapper lands the button stays visible, disabled, and performs no mutation.
    var bringBack: ((String) -> Void)?
    @State private var usage = DoneUsageState()
    @State private var confirmation = DoneRestoreConfirmation()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding()
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .textSelection(.enabled)
            }
            Divider()
            HStack {
                if let model = session.model { Text(verbatim: model) }
                Spacer()
                Text(verbatim: usage.display).monospacedDigit()
                Text(L.t("usage_prompt_tokens_unit"))
            }
            .font(.caption).foregroundStyle(.secondary).padding(12)
            .accessibilityIdentifier("queues-done-usage")
        }
        .frame(minWidth: 300, maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel(L.t("done_recap_panel_aria", session.desig))
        .accessibilityIdentifier("queues-done-recap")
        .task(id: session.id) {
            confirmation.disarm()
            await usage.load(id: session.id, read: loadUsage)
        }
        .task(id: confirmation.armedUntil) {
            guard confirmation.isArmed else { return }
            do { try await Task.sleep(for: .milliseconds(3_000)) } catch { return }
            confirmation.disarm()
        }
        .onDisappear { usage.close(); confirmation.disarm() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: session.desig).font(.headline)
                Spacer()
                Button(confirmation.isArmed ? L.t("donerecap_bringback_confirm") : L.t("donerecap_bringback")) {
                    if confirmation.tap(now: Int(Date.now.timeIntervalSince1970 * 1_000)) {
                        bringBack?(session.id)
                    }
                }
                .disabled(bringBack == nil)
                .accessibilityIdentifier("queues-done-bring-back")
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(verbatim: DonePresentation.finished(session, now: context.date))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch recap?.state.known {
        case .ready:
            if let recap {
                if let verdict = DonePresentation.verdict(recap) { DoneVerdictChip(verdict: verdict) }
                if !recap.headline.isEmpty { Text(verbatim: recap.headline).font(.title2) }
                // S8's VisualBlock has not reached the generated Recap in this worktree.
                // Markdown is the whole body renderer until that integration commit lands.
                if !recap.body.isEmpty {
                    Text(DoneMarkdown.render(recap.body))
                        .accessibilityIdentifier("queues-done-markdown")
                }
                if !recap.openItems.isEmpty {
                    Text(L.t("recap_open_items")).font(.headline)
                    ForEach(Array(recap.openItems.enumerated()), id: \.offset) { _, item in
                        Label { Text(verbatim: item) } icon: { Image(systemName: "circle") }
                    }
                }
                if let files = recap.changedFiles, !files.isEmpty {
                    Text(L.t("recap_changed_files")).font(.headline)
                    ForEach(Array(files.enumerated()), id: \.offset) { _, path in
                        Text(verbatim: path).font(.callout.monospaced())
                    }
                }
            }
        case .generating:
            ProgressView(L.t("recap_generating"))
                .accessibilityIdentifier("queues-done-generating")
        case .failed:
            if let recap { failure(recap) }
        case .empty, nil:
            Text(verbatim: DonePresentation.emptyCopy(session, recap: recap))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("queues-done-empty-recap")
        }
    }

    private func failure(_ recap: Recap) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: DonePresentation.failureHeadline(recap)).font(.headline)
            if DonePresentation.failureField(recap, "code") != nil {
                Text(verbatim: DonePresentation.failureAction(recap))
                DisclosureGroup(L.t("recap_failure_details")) {
                    LabeledContent(L.t("recap_failure_provider")) {
                        Text(verbatim: DonePresentation.failureField(recap, "provider") ?? "—")
                    }
                    LabeledContent(L.t("recap_failure_model")) {
                        Text(verbatim: DonePresentation.failureField(recap, "model")
                             ?? L.t("recap_failure_default_model"))
                    }
                    if let detail = DonePresentation.failureField(recap, "detail") {
                        LabeledContent(L.t("recap_failure_detail")) { Text(verbatim: detail) }
                    }
                }
            } else {
                if !recap.headline.isEmpty { Text(verbatim: recap.headline) }
                if !recap.body.isEmpty { Text(verbatim: recap.body) }
            }
        }
        .accessibilityIdentifier("queues-done-failed")
    }
}
