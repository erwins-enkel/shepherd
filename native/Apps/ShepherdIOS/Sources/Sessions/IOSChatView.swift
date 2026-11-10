import ShepherdAppCore
import ShepherdKit
import SwiftUI
import UIKit
import PhotosUI

/// Mounted only for the selected Chat tab. The feed and draft live in the detail
/// so changing tabs retains pending echoes and unsent words without polling offscreen.
struct IOSChatView: View {
    let session: Session
    var detail: DetailModel? = nil
    let model: IOSChatModel
    let allowsInput: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    private var askFlow: AskAnswerFlow { model.askFlow }

    private var remote: Bool { RemoteSessionCopy.isMirrored(session) }
    private var connected: Bool { !remote || session.connection?.state.known == .connected }
    private var canWrite: Bool { allowsInput && connected && isCurrent && app.liveRequestAudit == nil }

    private var isCurrent: Bool {
        scenePhase == .active && app.selectedSessionID == session.id
            && (remote
                ? app.store?.remoteSession(id: session.id)?.host?.instanceId == session.host?.instanceId
                    && app.store?.remoteSession(id: session.id)?.connection?.state.known == .connected
                : app.extension(DetailModel.self) === detail && detail?.isActive == true)
    }

    var body: some View {
        VStack(spacing: 0) {
            if remote && canWrite {
                IOSAskStrip(ask: model.ask, status: askFlow.status,
                    open: { askFlow.reopen($0) }, clear: { askFlow.clearStatus(toolUseID: $0) })
            }
            IOSChatContent(model: model, allowsInput: canWrite, send: send)
        }
            .task(id: "\(session.id):\(app.activationGeneration):\(scenePhase):\(session.status.rawValue):\(connected)") {
                if remote && !connected && model.data == nil { model.loadFailed = true }
                guard isCurrent, connected, let store = app.store else { return }
                let generation = app.activationGeneration
                if canWrite, model.attachments == nil {
                    model.attachments = .forSession(client: store.client, sessionID: session.id)
                }
                if canWrite, !remote, model.dictation == nil {
                    model.dictation = IOSDictationSession(client: store.client, defaults: app.composerDefaults,
                        context: [session.repoPath, session.baseBranch],
                        whisperStatus: app.extension(IOSTerminalController.self)?.whisperStatus,
                        getText: { [weak model] in model?.draft ?? "" },
                        setText: { [weak model] in model?.draft = $0 })
                    model.dictation?.engine.probeWhisper()
                }
                await model.poll(fetch: { try await store.client.messages(sessionID: session.id) },
                    running: { (remote ? store.remoteSession(id: session.id) : store.session(id: session.id))?.status.known == .running },
                    isCurrent: { isCurrent && connected && app.store === store && app.activationGeneration == generation },
                    fetchAsk: remote ? { try await store.client.blocks(host: session.host?.instanceId)[session.id]?.ask } : nil)
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase != .active, let voice = model.dictation?.voice else { return }
                if voice.capturing { voice.finalize() } else if voice.state == .arming { voice.cancel() }
            }
            .onChange(of: allowsInput) { _, allowed in if !allowed { model.stopDictation() } }
            .onChange(of: connected) { _, connected in if !connected { model.stopDictation() } }
            .onChange(of: model.ask?.toolUseId) { _, _ in askFlow.sync(ask: model.ask) }
            .onAppear { askFlow.sync(ask: model.ask) }
            .sheet(isPresented: Binding(get: { remote && canWrite && model.ask != nil && askFlow.presentedID == model.ask?.toolUseId },
                set: { if !$0 { askFlow.dismiss() } })) {
                if let ask = model.ask {
                    IOSAskSheet(ask: ask, model: askFlow.form(sessionID: session.id, ask: ask), submit: submitAsk)
                }
            }
            .onDisappear { model.stopDictation() }
    }

    private func submitAsk() {
        guard canWrite, let ask = model.ask, let client = app.store?.client else { return }
        Task { await askFlow.submit(sessionID: session.id, ask: ask, writer: .live(client: client)) }
    }

    private func send() {
        guard canWrite, let store = app.store else { return }
        let generation = app.activationGeneration
        Task {
            await model.send(isCurrent: {
                canWrite && app.store === store && app.activationGeneration == generation
            }, reply: { try await store.client.replySession(id: session.id, text: $0) })
        }
    }
}

/// Production rows and composer, with a static rendering path for ImageRenderer.
struct IOSChatContent: View {
    @Bindable var model: IOSChatModel
    let allowsInput: Bool
    var fixture = false
    var send: () -> Void = {}
    @FocusState private var focused: Bool
    @State private var picked: [PhotosPickerItem] = []
    @Environment(\.openURL) private var openURL
    private var voice: DictationController? { model.dictation?.voice }

    var body: some View {
        VStack(spacing: 0) {
            if fixture {
                transcript.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        transcript
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: model.rows) { _, _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
                    .onChange(of: model.waiting) { _, _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
            }
            if allowsInput { composer }
        }
        .foregroundStyle(ComposePalette.ink).background(ComposePalette.bg)
        .tint(ComposePalette.amber)
        .accessibilityIdentifier("detail-tab-chat")
        .onChange(of: voice?.active) { _, active in if active == true { focused = false } }
        .alert(L.t("native_compose_voice_label"), isPresented: Binding(
            get: { model.dictation?.engine.needsAppleServerConsent == true },
            set: { if !$0 { model.dictation?.engine.resolveAppleServerConsent(false) } })) {
                Button(L.t("native_compose_voice_allow")) { model.dictation?.engine.resolveAppleServerConsent(true) }
                Button(L.t("common_cancel"), role: .cancel) { model.dictation?.engine.resolveAppleServerConsent(false) }
            } message: { Text(L.t("native_compose_voice_apple_disclosure")) }
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.loadFailed {
                Text(L.t("native_ios_chat_load_failed")).foregroundStyle(ComposePalette.red)
                    .accessibilityIdentifier("chat-load-error")
            }
            if let data = model.data {
                if data.unavailable != nil {
                    Text(L.t("native_ios_chat_unavailable")).foregroundStyle(ComposePalette.muted)
                } else if model.rows.isEmpty && model.waiting.isEmpty {
                    Text(L.t("session_chat_empty")).foregroundStyle(ComposePalette.muted)
                }
            } else if !model.loadFailed {
                if fixture { Text(L.t("common_loading")) }
                else { ProgressView(L.t("common_loading")) }
            }
            let rows = model.rows
            let marks = ChatTimeline.ledger(rows)
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                HStack(alignment: .top, spacing: 8) {
                    Text(verbatim: marks[index].time ?? "")
                        .font(.system(.caption2, design: .monospaced)).monospacedDigit()
                        .foregroundStyle(ComposePalette.muted).fixedSize(horizontal: true, vertical: false)
                        .frame(minWidth: 38, alignment: .leading)
                        .accessibilityHidden(marks[index].time == nil)
                    IOSChatRow(row: row, fixture: fixture)
                }
                .padding(.top, marks[index].turn ? 8 : 0)
                .overlay(alignment: .top) {
                    if marks[index].turn { Rectangle().fill(ComposePalette.line).frame(height: 1) }
                }
            }
            ForEach(model.waiting) { send in
                VStack(alignment: .trailing, spacing: 4) {
                    operatorBubble(send.text)
                    Text(L.t("native_ios_chat_pending")).font(.caption2).foregroundStyle(ComposePalette.muted)
                }.frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .font(.system(.subheadline))
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("session_chat_log"))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let voice, voice.active {
                TranscriptPreview(voice: voice, audioEngine: model.dictation?.engine)
                Text(L.t(voice.state == .locked ? "native_compose_voice_locked" : "native_compose_voice_no_send"))
                    .font(.caption).foregroundStyle(ComposePalette.muted)
            }
            if let attachments = model.attachments {
                IOSReplyAttachmentChips(attachments: attachments, thumbnails: [:],
                    rendersStaticFixture: fixture, enabled: !model.sending)
                if let error = attachments.importError { Text(verbatim: error).foregroundStyle(ComposePalette.red) }
                if attachments.inFlight { Text(L.t("common_loading")).foregroundStyle(ComposePalette.muted) }
            }
            HStack(alignment: .bottom, spacing: 6) {
                if model.attachments != nil {
                    PhotosPicker(selection: $picked, selectionBehavior: .ordered, matching: .images) {
                        Image(systemName: "photo.badge.plus").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel(L.t("native_compose_attach"))
                    .accessibilityIdentifier("chat-attach")
                    .disabled(model.sending || voice?.active == true)
                    .onChange(of: picked) { _, items in importPhotos(items); picked = [] }
                }
                Group {
                    if fixture {
                        Text(verbatim: model.draft.isEmpty ? L.t("session_chat_placeholder") : model.draft)
                            .foregroundStyle(model.draft.isEmpty ? ComposePalette.muted : ComposePalette.ink)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    } else {
                        TextField(L.t("session_chat_placeholder"), text: $model.draft, axis: .vertical)
                            .lineLimit(1...5).focused($focused).frame(minHeight: 44)
                            .disabled(model.sending || voice?.active == true)
                    }
                }
                .accessibilityLabel(L.t("session_chat_input_label")).accessibilityIdentifier("chat-draft")
                if let voice {
                    HoldToTalkButton(voice: voice, compact: true, plainCompact: true,
                        rendersStaticFixture: fixture, enabled: !model.sending && voice.state != .finalizing,
                        canBegin: { allowsInput && !model.sending })
                        .disabled(model.sending || voice.state == .finalizing)
                        .contextMenu {
                            Button("DE") { voice.locale = "de-DE" }
                            Button("EN") { voice.locale = "en-US" }
                        }
                        .accessibilityAction(named: L.t("native_compose_voice_language") + " DE") { voice.locale = "de-DE" }
                        .accessibilityAction(named: L.t("native_compose_voice_language") + " EN") { voice.locale = "en-US" }
                } else if fixture {
                    Image(systemName: "mic.fill").frame(width: 44, height: 44).foregroundStyle(ComposePalette.amber)
                }
                Button(action: send) {
                    Text(L.t("assistant_chat_send")).font(.subheadline.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain).foregroundStyle(model.canSend ? ComposePalette.amber : ComposePalette.faint)
                .disabled(!model.canSend).accessibilityIdentifier("chat-send")
            }
            .padding(.horizontal, 10).padding(.vertical, 4).background(ComposePalette.panel)
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(ComposePalette.line))
            if let voice {
                if voice.canUndo || voice.state == .locked {
                    Button(L.t(voice.canUndo ? "native_compose_voice_undo" : "common_cancel")) {
                        if voice.canUndo { voice.undo() } else { voice.cancel() }
                    }.frame(minHeight: 44).disabled(model.sending)
                }
                if let notice = voice.noticeCopy {
                    Text(verbatim: notice).foregroundStyle(ComposePalette.red)
                    if voice.state == .denied {
                        Button(L.t("native_compose_voice_settings")) {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }.frame(minHeight: 44)
                    }
                }
            }
            if model.sendFailed {
                Text(L.t("native_ios_chat_send_failed")).foregroundStyle(ComposePalette.red)
                    .accessibilityIdentifier("chat-send-error")
            }
        }
        .font(.subheadline).padding(12).background(ComposePalette.bg)
        .overlay(alignment: .top) { Rectangle().fill(ComposePalette.line).frame(height: 1) }
        .accessibilityIdentifier("chat-composer")
    }

    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard allowsInput, !model.sending, let attachments = model.attachments else { return }
        let reserved = items.compactMap { item in attachments.beginImport().map { (item, $0) } }
        Task {
            for (item, stamp) in reserved {
                do {
                    let data = try await item.loadTransferable(type: Data.self)
                    let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    attachments.finishImport(data.map { .init(name: "photo-\(UUID().uuidString).\(ext)", data: $0) },
                        error: data == nil ? L.t("native_ios_attachment_invalid") : nil, generation: stamp)
                } catch { attachments.finishImport(nil, error: ShepherdErrorCopy.message(error), generation: stamp) }
            }
        }
    }

    @ViewBuilder private func operatorBubble(_ text: String) -> some View {
        if fixture { IOSChatOperatorBubble(text: text) }
        else { IOSChatOperatorBubble(text: text).textSelection(.enabled) }
    }
}

private struct IOSChatOperatorBubble: View {
    let text: String
    var body: some View {
        Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
            .padding(10).background(ComposePalette.panel)
            .overlay(alignment: .trailing) { Rectangle().fill(ComposePalette.amber).frame(width: 2) }
    }
}

private struct IOSChatRow: View {
    let row: ChatTimeline.Row
    let fixture: Bool
    var body: some View {
        Group {
            if row.kind == .tools {
                DisclosureGroup {
                    ForEach(Array(row.calls.enumerated()), id: \.offset) { _, call in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: call.tool).font(.caption.monospaced().weight(.semibold))
                            Text(verbatim: call.summary).fixedSize(horizontal: false, vertical: true)
                            if call.status.known == .error { Text(L.t("chat_tool_error")) }
                        }
                        .foregroundStyle(call.status.known == .error ? ComposePalette.red : ComposePalette.muted)
                    }
                } label: {
                    Text(row.calls.count == 1 ? L.t("chat_tools_one") : L.t("chat_tools_many", String(row.calls.count)))
                        .font(.caption).frame(minHeight: 44, alignment: .leading)
                }.foregroundStyle(ComposePalette.muted).tint(ComposePalette.muted)
            } else if let entry = row.entry {
                switch entry.kind {
                case .assistant:
                    IOSChatMarkdown(source: entry.text)
                case .user:
                    HStack {
                        Spacer(minLength: 20)
                        if entry.initial {
                            IOSChatMarkdown(source: entry.text).padding(10).background(ComposePalette.panel)
                        } else { IOSChatOperatorBubble(text: entry.text) }
                    }
                case .steer:
                    DisclosureGroup {
                        Text(verbatim: entry.text).fixedSize(horizontal: false, vertical: true)
                    } label: {
                        Text(L.t("session_chat_steer_by", steerLabel(entry.steer)))
                            .font(.caption).frame(minHeight: 44, alignment: .leading)
                    }.foregroundStyle(ComposePalette.muted).tint(ComposePalette.muted)
                case .event:
                    Label { Text(verbatim: entry.text) } icon: { Image(systemName: "waveform.path") }
                        .font(.caption).foregroundStyle(ComposePalette.muted)
                case .tools: EmptyView()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disclosureGroupStyle(IOSChatDisclosureStyle())
        .modifier(ChatSelection(fixture: fixture))
    }

    private func steerLabel(_ kind: String?) -> String {
        switch kind {
        case "go": L.t("pulse_event_go")
        case "plan_review": L.t("pulse_event_plan_review")
        case "ci_fix": L.t("pulse_event_ci_fix")
        case "rebase": L.t("pulse_event_rebase")
        case "open_pr": L.t("pulse_event_open_pr")
        case "review": L.t("pulse_event_review")
        case "queue": L.t("pulse_event_queue")
        case "api_retry": L.t("pulse_event_api_retry")
        default: L.t("pulse_event_nudge")
        }
    }
}

private struct ChatSelection: ViewModifier {
    let fixture: Bool
    func body(content: Content) -> some View {
        if fixture { content } else { content.textSelection(.enabled) }
    }
}

/// Explicit ink for the disclosure chevron, including static ImageRenderer output.
private struct IOSChatDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { configuration.isExpanded.toggle() } label: {
                HStack {
                    configuration.label
                    Spacer(minLength: 8)
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(ComposePalette.muted)
                        .accessibilityHidden(true)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(L.t(configuration.isExpanded ? "native_ios_group_expanded" : "native_ios_group_collapsed"))
            if configuration.isExpanded { configuration.content.padding(.leading, 12) }
        }
    }
}

/// Reuse the plan renderer's Markdown block parser, with the design system's
/// reading font for conversation prose. Inline Markdown keeps its own traits.
private struct IOSChatMarkdown: View {
    let source: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(IOSPlanMarkdownView.blocks(source).enumerated()), id: \.offset) { _, block in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let marker = block.marker { Text(verbatim: marker).accessibilityHidden(true) }
                    Text(block.text)
                        .font(.system(block.heading ? .headline : .subheadline))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(block.heading ? .isHeader : [])
                }.padding(.leading, CGFloat(min(block.depth, 5) * 12))
            }
        }
    }
}
