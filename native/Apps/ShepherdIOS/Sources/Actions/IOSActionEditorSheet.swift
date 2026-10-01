import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSActionEditorSheet: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    let repos: [Repo]
    let kind: IOSSessionActionState.Sheet
    var body: some View {
        NavigationStack {
            ScrollView { IOSActionEditorContent(session: session, state: state, repos: repos, kind: kind).padding(16) }
                .background(SessionListStyle.background)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_cancel"), action: state.dismiss).disabled(state.busy)
                } }
        }
        .tint(SessionListStyle.amber).preferredColorScheme(.dark)
        .interactiveDismissDisabled(state.busy)
        .presentationDetents([.large])
    }
    private var title: String {
        switch kind {
        case .rename: L.t("viewport_rename_aria")
        case .amend: L.t("amend_title", session.name)
        case .relaunch: L.t("native_actions_relaunch_confirm_title")
        case .merge: L.t("prbadge_merge")
        }
    }
}

/// The production field layout also renders with static text for ImageRenderer:
/// UIKit-backed TextEditor and Picker do not draw into its SwiftUI display list.
struct IOSActionEditorContent: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    let repos: [Repo]
    let kind: IOSSessionActionState.Sheet
    var rendersStaticFixture = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            IOSActionFeedback(error: state.error, busy: state.busy, rendersStaticFixture: rendersStaticFixture)
            switch kind {
            case .rename:
                field(L.t("viewport_rename_aria"), text: $state.name, id: "rename-field")
            case .amend:
                Text(L.t("amend_original_task")).foregroundStyle(SessionListStyle.muted)
                Text(verbatim: session.prompt).fixedSize(horizontal: false, vertical: true)
                editor(L.t("cardmenu_amend"), text: $state.amendment, id: "amend-field")
                if rendersStaticFixture {
                    Label(L.t("amend_steer_label"), systemImage: state.steer ? "checkmark.square" : "square")
                        .fixedSize(horizontal: false, vertical: true)
                } else { Toggle(L.t("amend_steer_label"), isOn: $state.steer).frame(minHeight: 44) }
                Text(verbatim: "\(AmendSubmission.maxCharacters - AmendSubmission.length(of: state.amendment))")
                    .monospacedDigit().foregroundStyle(SessionListStyle.muted)
                    .accessibilityLabel(L.t("native_ios_actions_remaining",
                        String(AmendSubmission.maxCharacters - AmendSubmission.length(of: state.amendment))))
            case .relaunch:
                Text(L.t("native_actions_relaunch_confirm_body"))
                    .foregroundStyle(SessionListStyle.amber).fixedSize(horizontal: false, vertical: true)
                if rendersStaticFixture {
                    staticField(L.t("newtask_repo_label"), value: state.repo)
                } else {
                    Picker(L.t("newtask_repo_label"), selection: $state.repo) {
                        // Keep the original repo selectable even when it is absent from discovery.
                        Text(verbatim: session.repoPath).tag(session.repoPath)
                        ForEach(repos.filter { !$0.hidden && $0.path != session.repoPath }, id: \.path) { repo in
                            Text(verbatim: repo.name).tag(repo.path)
                        }
                    }.pickerStyle(.menu).frame(minHeight: 44).accessibilityIdentifier("relaunch-repo")
                }
                field(L.t("newtask_branch_label"), text: $state.branch, id: "relaunch-branch")
                editor(L.t("newtask_prompt_label"), text: $state.prompt, id: "relaunch-prompt")
            case .merge: EmptyView()
            }
            Button(role: kind == .relaunch ? .destructive : nil) { Task { await state.submit() } } label: {
                Text(verbatim: submitTitle).frame(maxWidth: .infinity)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle()).disabled(!state.canSubmit)
            .accessibilityIdentifier("\(kind.rawValue)-submit")
        }
        .disabled(state.busy)
        .sessionFont().foregroundStyle(SessionListStyle.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private var submitTitle: String {
        switch kind {
        case .rename: L.t("common_save")
        case .amend: L.t("amend_submit")
        case .relaunch: L.t("native_actions_relaunch_confirm_action")
        case .merge: L.t("mergeconfirm_confirm")
        }
    }
    @ViewBuilder private func field(_ title: String, text: Binding<String>, id: String) -> some View {
        if rendersStaticFixture { staticField(title, value: text.wrappedValue) }
        else {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: title).foregroundStyle(SessionListStyle.muted)
                TextField(title, text: text, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(12).frame(minHeight: 44).background(ComposePalette.panel)
                    .accessibilityIdentifier(id)
            }
        }
    }
    @ViewBuilder private func editor(_ title: String, text: Binding<String>, id: String) -> some View {
        if rendersStaticFixture { staticField(title, value: text.wrappedValue) }
        else {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: title).foregroundStyle(SessionListStyle.muted)
                TextEditor(text: text).frame(minHeight: 160)
                    .scrollContentBackground(.hidden).padding(8).background(ComposePalette.panel)
                    .accessibilityLabel(title).accessibilityIdentifier(id)
            }
        }
    }
    private func staticField(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: title).foregroundStyle(SessionListStyle.muted)
            Text(verbatim: value).fixedSize(horizontal: false, vertical: true)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(ComposePalette.panel)
        }
    }
}

struct IOSRecapSheet: View {
    let recap: Recap?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { IOSRecapContent(recap: recap).padding(16) }
                .background(SessionListStyle.background)
                .navigationTitle(L.t("feat_visual_recap_title"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button(L.t("common_close")) { dismiss() }
                } }
        }.preferredColorScheme(.dark).tint(SessionListStyle.amber)
    }
}

struct IOSRecapContent: View {
    let recap: Recap?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let recap {
                if let line = RecapLine.content(for: recap) {
                    Text(verbatim: line.verdict).foregroundStyle(SessionListStyle.muted)
                    Text(verbatim: line.headline).sessionFont(weight: .semibold)
                }
                if recap.state.known == .generating { Text(L.t("recap_generating")) }
                else if recap.state.known == .failed { Text(L.t("recap_failed")) }
                else if recap.state.known == .empty { Text(L.t("recap_empty_legacy")) }
                Text((try? AttributedString(markdown: recap.body)) ?? AttributedString(recap.body)).fixedSize(horizontal: false, vertical: true)
                ForEach(Array(recap.openItems.enumerated()), id: \.offset) { _, item in
                    Label(item, systemImage: "circle").fixedSize(horizontal: false, vertical: true)
                }
                if let files = recap.changedFiles, !files.isEmpty {
                    Text(L.t("recap_changed_files")).foregroundStyle(SessionListStyle.muted)
                    ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                        Text(verbatim: file).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else { Text(L.t("recap_unavailable")) }
        }.sessionFont().foregroundStyle(SessionListStyle.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
