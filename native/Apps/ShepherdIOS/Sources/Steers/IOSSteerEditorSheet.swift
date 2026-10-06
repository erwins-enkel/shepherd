import Observation
import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// One steer being edited from the steers panel. A reference type so dictation can
/// write into the prompt from outside the view's lifetime-bound state.
@MainActor
@Observable
final class IOSSteerDraft: Identifiable {
    let id: String
    let isNew: Bool
    var steer: ComposeSteer
    /// Hold-to-talk into the prompt; nil where recording is not allowed.
    @ObservationIgnored var dictation: IOSDictationSession?

    init(editing steer: ComposeSteer?) {
        let initial = steer ?? ComposeSteer(id: UUID().uuidString, label: "", text: "", inSteerBar: true, onIssues: false)
        isNew = steer == nil
        id = initial.id
        self.steer = initial
    }

    var canSave: Bool { ComposeActions.isValidSteer(steer) }
}

/// Edits name, emoji, prompt and placement of one steer in place. Repo and agent
/// scope stay as they are: they are rarely changed and the web/Mac editor owns them.
struct IOSSteerEditorSheet: View {
    @Bindable var draft: IOSSteerDraft
    let library: SteerLibrary
    let save: (ComposeSteer) async -> Bool
    let delete: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmDelete = false
    private var voice: DictationController? { draft.dictation?.voice }

    var body: some View {
        NavigationStack {
            ScrollView {
                IOSSteerEditorContent(draft: draft, error: library.saveError, voice: voice,
                    delete: draft.isNew ? nil : { confirmDelete = true })
                    .padding(16)
            }
            .background(SessionListStyle.background)
            .navigationTitle(L.t(draft.isNew ? "native_ios_steers_add" : "native_ios_steers_edit_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_cancel")) { dismiss() }.disabled(library.saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if library.saving { ProgressView() }
                    else {
                        Button(L.t("common_save")) {
                            Task { if await save(draft.steer) { dismiss() } }
                        }
                        .disabled(!draft.canSave || voice?.active == true)
                        .accessibilityIdentifier("steer-editor-save")
                    }
                }
            }
            .confirmationDialog(L.t("steerseditor_remove_confirm"), isPresented: $confirmDelete, titleVisibility: .visible) {
                Button(L.t("native_ios_steers_delete"), role: .destructive) {
                    Task { if await delete(draft.steer.id) { dismiss() } }
                }
            }
        }
        .tint(SessionListStyle.amber).preferredColorScheme(.dark)
        .interactiveDismissDisabled(library.saving)
        .presentationDetents([.large])
        .onAppear { library.clearSaveError() }
        .onChange(of: scenePhase) { _, phase in
            guard let voice, phase != .active else { return }
            if voice.capturing { voice.finalize() } else if voice.state == .arming { voice.cancel() }
        }
        .onDisappear { draft.dictation?.engine.stopWhisperProbe(); voice?.teardown() }
    }
}

/// The fields, split out so a fixture can render them without the sheet chrome.
struct IOSSteerEditorContent: View {
    @Bindable var draft: IOSSteerDraft
    let error: String?
    let voice: DictationController?
    let delete: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let error {
                Text(verbatim: error).foregroundStyle(ComposePalette.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("steer-editor-error")
            }
            HStack(alignment: .bottom, spacing: 8) {
                field(L.t("steerseditor_field_emoji"), text: Binding(
                    get: { draft.steer.emoji ?? "" },
                    set: { draft.steer.emoji = $0.isEmpty ? nil : $0 }), id: "steer-editor-emoji")
                    .frame(width: 84)
                field(L.t("steerseditor_field_name"), text: $draft.steer.label, id: "steer-editor-name")
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(verbatim: L.t("steerseditor_field_prompt")).foregroundStyle(SessionListStyle.muted)
                    Spacer()
                    if let voice {
                        HoldToTalkButton(voice: voice, compact: true, plainCompact: true,
                            enabled: voice.state != .finalizing)
                    }
                }
                TextEditor(text: $draft.steer.text).frame(minHeight: 160)
                    .scrollContentBackground(.hidden).padding(8).background(ComposePalette.panel)
                    .accessibilityLabel(L.t("steerseditor_text_aria"))
                    .accessibilityIdentifier("steer-editor-prompt")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: L.t("steerseditor_field_show_in")).foregroundStyle(SessionListStyle.muted)
                Toggle(L.t("steerseditor_placement_bar"), isOn: $draft.steer.inSteerBar).frame(minHeight: 44)
                Toggle(L.t("steerseditor_placement_issues"), isOn: $draft.steer.onIssues).frame(minHeight: 44)
                if !draft.steer.inSteerBar && !draft.steer.onIssues {
                    Text(verbatim: L.t("native_ios_steers_placement_required"))
                        .font(.caption).foregroundStyle(ComposePalette.red)
                }
            }
            if let delete {
                Button(role: .destructive, action: delete) {
                    Label(L.t("native_ios_steers_delete"), systemImage: "trash").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(ComposeControlStyle())
                .foregroundStyle(ComposePalette.red)
                .accessibilityIdentifier("steer-editor-delete")
            }
        }
        .sessionFont().foregroundStyle(SessionListStyle.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func field(_ title: String, text: Binding<String>, id: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: title).foregroundStyle(SessionListStyle.muted)
            TextField(title, text: text)
                .autocorrectionDisabled()
                .padding(12).frame(minHeight: 44).background(ComposePalette.panel)
                .accessibilityIdentifier(id)
        }
    }
}
