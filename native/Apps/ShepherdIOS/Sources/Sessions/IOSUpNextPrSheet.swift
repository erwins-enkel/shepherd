import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// The PR sheet: facts, the server's recommended action first, every other action behind it.
/// ‹ › page through the list's PR rows; Done closes. Merging always goes through the merge
/// confirmation, never straight from a button.
struct IOSUpNextPrSheet: View {
    let rows: [IOSUpNextPrRow]
    let select: (AppModel, String) -> Void
    @State private var current: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(rows: [IOSUpNextPrRow], initial: IOSUpNextPrSelection, select: @escaping (AppModel, String) -> Void) {
        self.rows = rows; self.select = select; _current = State(initialValue: initial.id)
    }

    private var index: Int? { rows.firstIndex { $0.id == current } }
    private var row: IOSUpNextPrRow? { index.map { rows[$0] } }

    var body: some View {
        NavigationStack {
            if let row, let index {
                IOSUpNextPrSheetContent(row: row, select: select, finished: { dismiss() })
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            HStack(spacing: 0) {
                                pager("chevron.left", label: L.t("native_ios_upnext_pr_prev"), to: index - 1, id: "queues-upnext-pr-prev")
                                pager("chevron.right", label: L.t("native_ios_upnext_pr_next"), to: index + 1, id: "queues-upnext-pr-next")
                            }
                        }
                        ToolbarItem(placement: .principal) {
                            Text(verbatim: L.t("native_ios_upnext_pr_sheet_title", String(row.pr.number)))
                                .sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
                                .accessibilityAddTraits(.isHeader)
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button(L.t("native_ios_upnext_pr_done")) { dismiss() }.fontWeight(.semibold)
                                .accessibilityIdentifier("queues-upnext-pr-done")
                        }
                    }
                    .navigationBarTitleDisplayMode(.inline)
            } else {
                // The PR left the queue (merged, closed) while the sheet was up.
                Color.clear.onAppear { dismiss() }
            }
        }
        .presentationDetents([.large])
        .preferredColorScheme(.dark).tint(SessionListStyle.amber)
        .accessibilityIdentifier("queues-upnext-pr-sheet")
    }

    private func pager(_ symbol: String, label: String, to target: Int, id: String) -> some View {
        Button { if rows.indices.contains(target) { current = rows[target].id } } label: {
            Image(systemName: symbol).font(.system(size: 16, weight: .semibold))
                .frame(minWidth: 40, minHeight: 44).contentShape(Rectangle())
        }
        .disabled(!rows.indices.contains(target))
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}

struct IOSUpNextPrSheetContent: View {
    let row: IOSUpNextPrRow
    let select: (AppModel, String) -> Void
    let finished: () -> Void
    var now = Date()
    @Environment(\.openURL) private var openURL

    private var pr: UpNextPr { row.pr }
    private var controller: IOSUpNextPrController? { row.controller }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                tagline
                Text(verbatim: pr.title).font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundStyle(SessionListStyle.bright).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("queues-upnext-pr-title")
                facts
                if let controller, controller.error != nil || controller.note != nil || controller.busy {
                    IOSActionFeedback(error: controller.error, note: controller.note, busy: controller.busy)
                }
                actions
                description
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24)
        }
        .sessionFont().foregroundStyle(SessionListStyle.ink).background(SessionListStyle.background)
        .sheet(isPresented: Binding(get: { controller?.mergeDraft != nil }, set: { if !$0 { controller?.dismissMerge() } })) {
            if let controller { IOSUpNextPrMergeSheet(controller: controller, merged: finished) }
        }
    }

    private var tagline: some View {
        HStack(spacing: 10) {
            Text(verbatim: L.t("native_ios_upnext_pr_kind").uppercased())
                .font(.system(size: 10, design: .monospaced)).kerning(1.2)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
                .fixedSize().layoutPriority(1)
            ForEach(UpNextPrPresentation.tagline(pr, now: now), id: \.self) { part in
                Text(verbatim: part).foregroundStyle(SessionListStyle.muted)
            }
            if let name = row.serverName { IOSServerHint(name: name) }
        }
        .sessionFont(label: true)
        .lineLimit(1).minimumScaleFactor(0.8)
    }

    private var facts: some View {
        VStack(spacing: 0) {
            let mergeability = UpNextPrPresentation.mergeability(pr)
            fact(L.t("native_ios_upnext_pr_fact_mergeable")) {
                Text(verbatim: mergeability.text).foregroundStyle(IOSUpNextPrStatusLine.color(mergeability.tone))
                    .kerning(mergeability.tone == .green || mergeability.tone == .muted ? 0 : 0.6)
            }
            Divider().overlay(SessionListStyle.line)
            fact(L.t("native_ios_upnext_pr_fact_ci"), link: URL(string: pr.url + "/checks")) {
                IOSUpNextPrStatusLine(tokens: [UpNextPrPresentation.ciToken(pr)], repoLabel: nil)
            }
            Divider().overlay(SessionListStyle.line)
            fact(L.t("native_ios_upnext_pr_fact_review")) { Text(verbatim: UpNextPrPresentation.reviewLabel(pr)) }
            if let target = UpNextPrPresentation.targetLabel(pr) {
                Divider().overlay(SessionListStyle.line)
                fact(L.t("native_ios_upnext_pr_fact_target")) { Text(verbatim: target) }
            }
            if let closes = pr.closesIssue {
                Divider().overlay(SessionListStyle.line)
                fact(L.t("native_ios_upnext_pr_fact_closes"), link: UpNextPrPresentation.closesIssueURL(pr)) {
                    Text(verbatim: "#\(closes.number)")
                }
            }
        }
        .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.line, lineWidth: 1) }
        .accessibilityIdentifier("queues-upnext-pr-facts")
    }

    /// A 44 pt fact row; with a link the value opens the forge page and shows a chevron.
    private func fact<Value: View>(_ label: String, link: URL? = nil, @ViewBuilder value: () -> Value) -> some View {
        let line = HStack(spacing: 12) {
            Text(verbatim: label).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            Spacer(minLength: 8)
            value()
            if link != nil {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
        return Group {
            if let link {
                Button { openURL(link) } label: { line }.buttonStyle(.plain)
                    .accessibilityHint(L.t("native_ios_upnext_pr_open_forge"))
            } else { line.accessibilityElement(children: .combine) }
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            ForEach(UpNextPrPresentation.actions(pr), id: \.self) { action in
                let lock = action == .merge ? UpNextPrPresentation.mergeLock(pr) : nil
                Button { perform(action) } label: {
                    Text(verbatim: UpNextPrPresentation.label(action)).frame(maxWidth: .infinity)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(IOSUpNextPrActionStyle(primary: UpNextPrPresentation.isPrimary(action, for: pr), locked: lock != nil))
                .disabled(lock != nil || controller?.busy == true || controller?.allowsWrites != true)
                .accessibilityIdentifier("queues-upnext-pr-action-\(action.rawValue)")
                .accessibilityHint(lock ?? "")
                if let lock {
                    Text(verbatim: lock).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, -2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("queues-upnext-pr-merge-lock")
                }
            }
            if let url = URL(string: pr.url) {
                Button { openURL(url) } label: {
                    Text(verbatim: L.t("native_ios_upnext_pr_open_forge")).sessionFont(label: true).kerning(0.8)
                        .foregroundStyle(SessionListStyle.amber)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("queues-upnext-pr-open")
            }
        }
    }

    private var description: some View {
        NavigationLink {
            IOSUpNextPrDescription(pr: pr)
        } label: {
            HStack {
                Text(verbatim: L.t("native_ios_upnext_pr_description"))
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
            }
            .sessionFont().foregroundStyle(SessionListStyle.ink)
            .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.line, lineWidth: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("queues-upnext-pr-description")
    }

    private func perform(_ action: UpNextPr.Action) {
        guard let controller else { return }
        let app = row.app
        switch action {
        case .merge: controller.prepareMerge(pr)
        case .fix, .review:
            let kind: IOSUpNextPrSessionKind = action == .fix ? .fix : .review
            Task<Void, Never> {
                let started = await controller.startSession(kind, pr, select: { select(app, $0) })
                if started { finished() }
            }
        case .dependabotRebase: Task<Void, Never> { _ = await controller.requestRebase(pr) }
        case .approveOnForge: if let url = URL(string: pr.url) { openURL(url) }
        }
    }
}

/// 48 pt, uppercase, amber-filled for the recommendation, outlined otherwise, dashed when locked.
struct IOSUpNextPrActionStyle: ButtonStyle {
    var primary = false
    var locked = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let tint = primary ? SessionListStyle.amber : SessionListStyle.ink
        let enabled = isEnabled && !locked
        configuration.label
            .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.2)
            .textCase(.uppercase)
            .foregroundStyle(enabled ? tint : SessionListStyle.muted)
            .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 48)
            .background(primary && enabled ? SessionListStyle.amber.opacity(0.12) : .clear)
            .background(configuration.isPressed ? SessionListStyle.selected : .clear)
            .overlay {
                RoundedRectangle(cornerRadius: 2)
                    .stroke(enabled && primary ? SessionListStyle.amber : SessionListStyle.brightLine,
                            style: StrokeStyle(lineWidth: 1, dash: locked ? [4, 3] : []))
            }
    }
}

/// The PR body when the server sends one, else where to read it.
struct IOSUpNextPrDescription: View {
    let pr: UpNextPr
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let body = pr.body, !body.isEmpty {
                    Text(verbatim: body).textSelection(.enabled)
                } else {
                    Text(L.t("native_ios_upnext_pr_description_missing")).foregroundStyle(SessionListStyle.muted)
                    if let url = URL(string: pr.url) {
                        Button(L.t("native_ios_upnext_pr_open_forge")) { openURL(url) }
                            .buttonStyle(IOSActionButtonStyle()).accessibilityIdentifier("queues-upnext-pr-description-open")
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
        }
        .sessionFont().foregroundStyle(SessionListStyle.ink).background(SessionListStyle.background)
        .navigationTitle(L.t("native_ios_upnext_pr_description")).navigationBarTitleDisplayMode(.inline)
    }
}

/// The merge confirmation for a backlog PR: the same facts, method and arming delay as the
/// session merge sheet. A refused takeover re-arms it with the responsibility the server named.
struct IOSUpNextPrMergeSheet: View {
    let controller: IOSUpNextPrController
    var merged: () -> Void = {}
    @State private var clock = Date()
    @AccessibilityFocusState private var cancelFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                if let draft = controller.mergeDraft {
                    IOSUpNextPrMergeContent(controller: controller, draft: draft, clock: clock, merged: merged).padding(16)
                }
            }
            .sessionFont().foregroundStyle(SessionListStyle.ink).background(SessionListStyle.background)
            .navigationTitle(L.t("prbadge_merge")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_cancel")) { controller.dismissMerge() }
                    .disabled(controller.busy).accessibilityFocused($cancelFocused)
                    .accessibilityIdentifier("merge-cancel")
            } }
        }
        .interactiveDismissDisabled(controller.busy)
        .preferredColorScheme(.dark).tint(SessionListStyle.amber)
        .task(id: controller.mergeDraft?.presentedAt) {
            cancelFocused = true
            clock = Date()
            // The production arming delay matches the session merge sheet; confirmMerge checks
            // the timestamp too, so a stale rendered enabled button cannot act.
            do { try await Task.sleep(for: .milliseconds(350)); clock = Date() }
            catch { return }
        }
    }
}

struct IOSUpNextPrMergeContent: View {
    let controller: IOSUpNextPrController
    let draft: IOSUpNextPrMergeDraft
    var clock = Date()
    var merged: () -> Void = {}
    var rendersStaticFixture = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                Text(L.t("mergeconfirm_eyebrow")).foregroundStyle(SessionListStyle.muted)
                fact(L.t("mergeconfirm_field_repo"), draft.pr.repoLabel)
                fact(L.t("mergeconfirm_field_pr"), "#\(draft.pr.number) \(draft.pr.title)")
                fact(L.t("mergeconfirm_field_target"), draft.refusal?.baseRefName ?? draft.pr.baseRefName ?? L.t("mergeconfirm_value_unknown"))
                fact(L.t("mergeconfirm_field_method"), draft.method?.rawValue ?? draft.pr.mergeMethod ?? L.t("native_ios_actions_server_default"))
                IOSUpNextPrGateNotice(gate: draft.refusal?.gate)
            }
            if rendersStaticFixture {
                Label(L.t("native_merge_delete_branch"), systemImage: draft.deleteBranch ? "checkmark.square" : "square")
            } else {
                // Closures, not method references: a partially applied @MainActor method as a Binding
                // setter needs an isolated(any) thunk that crashes Xcode 26.6's IRGen.
                Picker(L.t("native_merge_method"), selection: Binding(get: { draft.method }, set: { controller.setMergeMethod($0) })) {
                    Text(L.t("native_ios_actions_server_default")).tag(Optional<MergeMethod>.none)
                    ForEach([MergeMethod.squash, .merge, .rebase], id: \.self) { method in
                        Text(verbatim: method.rawValue).tag(Optional(method))
                    }
                }.pickerStyle(.menu).frame(minHeight: 44).accessibilityIdentifier("merge-method")
                Toggle(L.t("native_merge_delete_branch"), isOn: Binding(get: { draft.deleteBranch }, set: { controller.setDeleteBranch($0) }))
                    .frame(minHeight: 44)
            }
            IOSActionFeedback(error: controller.error, busy: controller.busy, rendersStaticFixture: rendersStaticFixture)
            Button {
                Task<Void, Never> {
                    let done = await controller.confirmMerge()
                    if done { merged() }
                }
            } label: {
                Text(verbatim: draft.confirmTitle).frame(maxWidth: .infinity).fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle())
            .disabled(!controller.canConfirmMerge(now: clock))
            .accessibilityIdentifier("merge-confirm")
        }.disabled(controller.busy).sessionFont().foregroundStyle(SessionListStyle.ink)
    }

    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(verbatim: label.uppercased()).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            Text(verbatim: value).fixedSize(horizontal: false, vertical: true)
        }.accessibilityElement(children: .combine)
    }
}

/// Who the server says is responsible, from the 409 gate; empty before a refusal.
struct IOSUpNextPrGateNotice: View {
    let gate: MergeResponsibility?
    var body: some View {
        if let gate {
            if let who = gate.handoffWho {
                Text(verbatim: gate.handoff?.known == .reviewer
                    ? L.t("mergeconfirm_handoff_reviewer", who) : L.t("mergeconfirm_handoff_merger", who))
                    .foregroundStyle(SessionListStyle.amber).fixedSize(horizontal: false, vertical: true)
            }
            if let reviewer = gate.reviewBlockBy {
                Text(L.t("mergeconfirm_review_block", reviewer)).foregroundStyle(SessionListStyle.amber)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
