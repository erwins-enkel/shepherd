import SwiftUI
import ShepherdAppCore

struct IOSCommandBarSheet: View {
    let snapshot: IOSMergedSessionPresentation.Snapshot
    let facts: [IOSSessionIdentity: IOSCommandBarPresentation.SessionFacts]
    var availability = IOSCommandBarPresentation.Availability()
    var app: AppModel? = nil
    var initialQuery = ""
    let activate: (IOSCommandBarPresentation.Action) -> Void
    @State private var query = ""
    @State private var dictation: IOSDictationSession?
    @State private var acceptingTranscript = false
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    private var groups: [IOSCommandBarPresentation.Group] {
        IOSCommandBarPresentation.groups(query: query, snapshot: snapshot, facts: facts, availability: availability)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(verbatim: L.t("commandbar_title").uppercased())
                    .sessionFont(label: true, weight: .semibold).tracking(1.4)
                    .foregroundStyle(SessionListStyle.muted)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }
                .accessibilityLabel(L.t("common_close"))
            }.padding(.horizontal, 16)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
                TextField(L.t("commandbar_placeholder"), text: $query)
                    .font(.body).focused($focused).submitLabel(.go)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit { if let first = groups.first?.rows.first { run(first) } }
                    .disabled(dictation?.voice.active == true)
                    .accessibilityIdentifier("command-bar-field")
                if let voice = dictation?.voice {
                    HoldToTalkButton(voice: voice, compact: true)
                } else {
                    Image(systemName: "mic.fill").foregroundStyle(SessionListStyle.muted)
                        .frame(width: 44, height: 44).accessibilityHidden(true)
                }
            }
            .padding(10).background(SessionListStyle.background)
            .overlay { Rectangle().stroke(SessionListStyle.brightLine) }
            .padding(.horizontal, 16).padding(.bottom, 12)
            if let voice = dictation?.voice {
                voiceStatus(voice)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if groups.isEmpty {
                        Text(verbatim: L.t("commandbar_no_matches"))
                            .foregroundStyle(SessionListStyle.muted).padding(.vertical, 24)
                    }
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: group.title.uppercased()).sessionFont(label: true, weight: .medium)
                                .tracking(1.2).foregroundStyle(SessionListStyle.muted)
                                .padding(.horizontal, 10).padding(.vertical, 5).accessibilityAddTraits(.isHeader)
                            ForEach(group.rows) { row in option(row) }
                        }
                    }
                }.padding(.horizontal, 16).padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(SessionListStyle.panel).foregroundStyle(SessionListStyle.ink)
        .buttonStyle(.plain).tint(SessionListStyle.amber)
        .presentationDetents([.large]).preferredColorScheme(.dark)
        .accessibilityIdentifier("command-bar")
        .onAppear { query = initialQuery; focused = true; prepareDictation() }
        .onChange(of: dictation?.voice.active) { _, active in if active == true { focused = false } }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                if dictation?.voice.capturing == true { dictation?.voice.finalize() }
                else if dictation?.voice.state == .arming { dictation?.voice.cancel() }
            }
        }
        .onChange(of: app?.activationGeneration) { _, _ in
            acceptingTranscript = false
            dictation?.voice.teardown(); dictation?.engine.stopWhisperProbe()
        }
        .onDisappear {
            acceptingTranscript = false
            dictation?.voice.teardown(); dictation?.engine.stopWhisperProbe()
        }
        .alert(L.t("native_compose_voice_label"), isPresented: Binding(
            get: { dictation?.engine.needsAppleServerConsent == true },
            set: { if !$0 { dictation?.engine.resolveAppleServerConsent(false) } })) {
                Button(L.t("native_compose_voice_allow")) { dictation?.engine.resolveAppleServerConsent(true) }
                Button(L.t("common_cancel"), role: .cancel) { dictation?.engine.resolveAppleServerConsent(false) }
            } message: { Text(L.t("native_compose_voice_apple_disclosure")) }
    }

    private func option(_ row: IOSCommandBarPresentation.Row) -> some View {
        Button { run(row) } label: {
            HStack(alignment: .top, spacing: 10) {
                Group {
                    if let glyph = row.glyph { Text(verbatim: glyph) }
                    else { Image(systemName: row.symbol) }
                }.frame(width: 20).foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(highlight(row.title, positions: row.positions, color: SessionListStyle.bright))
                        .sessionFont(weight: .semibold).fixedSize(horizontal: false, vertical: true)
                    if !row.designationPositions.isEmpty {
                        Text(highlight(row.designation, positions: row.designationPositions, color: SessionListStyle.muted))
                            .sessionFont(label: true)
                    }
                    if !row.subtitle.isEmpty {
                        Text(highlight(row.subtitle, positions: row.repoPositions, color: SessionListStyle.muted))
                            .sessionFont(label: true).fixedSize(horizontal: false, vertical: true)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if row.index == 0 { Image(systemName: "return").foregroundStyle(SessionListStyle.amber).accessibilityHidden(true) }
            }
            .padding(10).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(row.index == 0 ? SessionListStyle.selected : SessionListStyle.panel)
            .overlay { Rectangle().stroke(row.index == 0 ? SessionListStyle.amber : SessionListStyle.line) }
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier("command-bar-row-\(row.index)")
    }

    private func highlight(_ text: String, positions: [Int], color: Color) -> AttributedString {
        let matches = Set(positions)
        var result = AttributedString()
        for (index, char) in text.enumerated() {
            var part = AttributedString(String(char))
            part.foregroundColor = matches.contains(index) ? SessionListStyle.amber : color
            result.append(part)
        }
        return result
    }

    @ViewBuilder private func voiceStatus(_ voice: DictationController) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if voice.active {
                Text(verbatim: voice.preview.isEmpty ? L.t("native_compose_voice_recording") : voice.preview)
                    .foregroundStyle(SessionListStyle.muted)
            }
            if voice.state == .locked {
                Button(L.t("native_compose_voice_stop")) { voice.finalize() }.frame(minHeight: 44)
                Button(L.t("common_cancel")) { voice.cancel() }.frame(minHeight: 44)
            }
            if let notice = voice.noticeCopy {
                Text(verbatim: notice).foregroundStyle(SessionListStyle.red)
                if voice.state == .denied {
                    Button(L.t("native_compose_voice_settings")) {
                        if let url = URL(string: "app-settings:") { openURL(url) }
                    }.frame(minHeight: 44)
                }
            }
        }.sessionFont().padding(.horizontal, 16)
    }

    private func run(_ row: IOSCommandBarPresentation.Row) {
        guard dictation?.voice.active != true else { return }
        focused = false; acceptingTranscript = false
        dictation?.voice.teardown()
        dismiss()
        activate(row.action)
    }

    private func prepareDictation() {
        guard dictation == nil, let app, let store = app.store, app.liveRequestAudit == nil else { return }
        let generation = app.activationGeneration
        acceptingTranscript = true
        dictation = IOSDictationSession(client: store.client, defaults: app.composerDefaults,
            context: snapshot.chips.map(\.name), whisperStatus: app.extension(IOSTerminalController.self)?.whisperStatus,
            getText: { query }, setText: { [weak app, weak store] text in
                guard acceptingTranscript, let app, app.store === store, app.activationGeneration == generation else { return }
                query = text
            })
        dictation?.engine.probeWhisper()
    }
}
