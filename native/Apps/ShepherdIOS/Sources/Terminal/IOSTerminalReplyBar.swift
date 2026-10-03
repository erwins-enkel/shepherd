import ShepherdAppCore
import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// One dock owns the microphone identity in both resting and writing states.
struct IOSTerminalReplyBar: View {
    let model: IOSTerminalPresentation
    var rendersStaticFixture = false
    var steerChips: AnyView? = nil
    var fixtureClipboard = false
    var fixtureThumbnails: [UUID: UIImage] = [:]
    @FocusState private var focused: Bool
    @State private var photos = false
    @State private var files = false
    @State private var camera = false
    @State private var photo: PhotosPickerItem?
    @State private var imports: IOSReplyImports?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let voice = model.voice, voice.active { recordingStatus(voice) }
            if let attachments = model.attachments, !attachments.rows.isEmpty {
                IOSReplyAttachmentChips(attachments: attachments, thumbnails: rendersStaticFixture ? fixtureThumbnails : imports?.thumbnails ?? [:],
                    rendersStaticFixture: rendersStaticFixture, enabled: !model.replying)
            }
            if model.showsWriting { draftField }
            // Keep this row and its trailing microphone mounted during a hold.
            HStack(spacing: 0) {
                attachMenu
                if !model.showsWriting && (model.clipboard.hasImage || fixtureClipboard) {
                    if rendersStaticFixture {
                        Image(systemName: "doc.on.clipboard").frame(width: 44, height: 44)
                            .foregroundStyle(ComposePalette.amber)
                            .background(ComposePalette.amber.opacity(0.12), in: Capsule())
                    } else {
                        IOSImagePasteControl(receive: { imports?.paste($0) }, enabled: model.canAttach)
                            .frame(width: 44, height: 44)
                    }
                }
                Group {
                    if model.showsWriting { accessoryKeys }
                    else if let steerChips { steerChips }
                    else { Spacer(minLength: 0) }
                }.frame(maxWidth: .infinity)
                if !model.showsWriting {
                    Button { model.openWriting(focus: true); focused = true } label: {
                        Image(systemName: "keyboard").frame(width: 44, height: 44)
                            .overlay(alignment: .topTrailing) {
                                if model.hasDraft { Circle().fill(ComposePalette.amber).frame(width: 7, height: 7).padding(7) }
                            }
                    }
                    .accessibilityLabel(L.t("native_ios_terminal_reply"))
                    .accessibilityValue(model.hasDraft ? L.t("native_ios_reply_draft") : "")
                    .accessibilityIdentifier("terminal-open-keyboard")
                }
                microphone
                if model.showsWriting {
                    Button { hideKeyboard() } label: { Image(systemName: "chevron.down").frame(width: 44, height: 44) }
                        .accessibilityLabel(L.t("newtask_compose_hide_keyboard_aria"))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(ComposePalette.ink)
            .padding(.horizontal, model.showsWriting ? 0 : 6)
            .frame(minHeight: model.showsWriting ? 44 : 56)
            .background { if !model.showsWriting { restingBackground } }
            if let voice = model.voice {
                if voice.canUndo || voice.state == .locked {
                    Button(L.t(voice.canUndo ? "native_compose_voice_undo" : "common_cancel")) {
                        if voice.canUndo { voice.undo() } else { voice.cancel() }
                    }.frame(minHeight: 44).disabled(model.replying)
                }
                if let notice = voice.noticeCopy {
                    Text(verbatim: notice).foregroundStyle(ComposePalette.red)
                        .accessibilityIdentifier("terminal-reply-voice-error")
                    if voice.state == .denied {
                        Button(L.t("native_compose_voice_settings")) {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }.frame(minHeight: 44)
                    }
                }
            }
            if let error = model.replyError ?? model.attachments?.importError {
                Text(verbatim: error).foregroundStyle(ComposePalette.red)
                    .accessibilityIdentifier("terminal-reply-error")
            }
        }
        .font(.system(.subheadline))
        .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 4)
        .accessibilityElement(children: .contain).accessibilityIdentifier("terminal-reply-bar")
        .onAppear {
            if !rendersStaticFixture { model.prepareDictation(); model.clipboard.refresh() }
            imports = IOSReplyImports(model: model)
        }
        .onChange(of: model.writing) { _, writing in focused = writing && model.writingWantsKeyboard && model.voice?.active != true }
        // ⌨ in a dialog's key row mounts this bar already writing; focus once the field exists.
        .task { if !rendersStaticFixture && model.writing && model.writingWantsKeyboard && model.voice?.active != true { focused = true } }
        .onChange(of: model.voice?.active) { _, active in
            if active == true { focused = false; model.openWriting(focus: false) }
        }
        .onChange(of: model.canRecordReply) { _, canSend in
            if !rendersStaticFixture && !canSend { focused = false; model.suspendDictation() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard !rendersStaticFixture else { return }
            if phase == .active { model.clipboard.refresh() }
            else { hideKeyboard(); model.suspendDictation() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            if !rendersStaticFixture { model.clipboard.refresh() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            if !rendersStaticFixture { model.closeWriting(); focused = false }
        }
        .onDisappear { if !rendersStaticFixture { hideKeyboard(); model.suspendDictation() } }
        .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): imports?.files(urls)
            case .failure(let error): model.attachments?.importError = ShepherdErrorCopy.message(error)
            }
        }
        // Picker lives outside Menu, whose content is destroyed on dismissal.
        .photosPicker(isPresented: $photos, selection: $photo, matching: .images)
        .onChange(of: model.attachments?.rows.map(\.id)) { _, _ in imports?.pruneThumbnails() }
        .onChange(of: photo) { _, item in if let item { imports?.photo(item); photo = nil } }
        .sheet(isPresented: $camera) {
            IOSReplyCamera { image in if let image { imports?.camera(image) }; camera = false }
                .ignoresSafeArea()
        }
        .alert(L.t("native_compose_voice_label"), isPresented: Binding(
            get: { model.audioEngine?.needsAppleServerConsent == true },
            set: { if !$0 { model.audioEngine?.resolveAppleServerConsent(false) } })) {
                Button(L.t("native_compose_voice_allow")) { model.audioEngine?.resolveAppleServerConsent(true) }
                Button(L.t("common_cancel"), role: .cancel) { model.audioEngine?.resolveAppleServerConsent(false) }
            } message: { Text(L.t("native_compose_voice_apple_disclosure")) }
    }

    private var draftField: some View {
        @Bindable var session = model.session
        return HStack(alignment: .bottom, spacing: 8) {
            Group {
                if rendersStaticFixture {
                    Text(verbatim: session.promptText.isEmpty ? L.t("native_terminal_prompt_placeholder") : session.promptText)
                        .foregroundStyle(session.promptText.isEmpty ? ComposePalette.muted : ComposePalette.ink)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                } else {
                    TextField(L.t("native_terminal_prompt_placeholder"), text: $session.promptText, axis: .vertical)
                        .lineLimit(1...5).focused($focused).frame(minHeight: 44)
                        .disabled(!model.canRecordReply)
                }
            }
            .accessibilityLabel(L.t("native_terminal_prompt_placeholder"))
            .accessibilityIdentifier("terminal-reply-text")
            Button {
                hideKeyboard()
                Task { _ = await model.submitReply() }
            } label: {
                Group {
                    if model.replying && !rendersStaticFixture { ProgressView() }
                    else { Image(systemName: model.replying ? "hourglass" : "arrow.up") }
                }.frame(width: 44, height: 44)
                    .foregroundStyle(model.canSubmitReply ? ComposePalette.bg : ComposePalette.faint)
                    .background(model.canSubmitReply ? ComposePalette.amber : ComposePalette.panel2, in: Circle())
            }
            .buttonStyle(.plain).disabled(!model.canSubmitReply)
            .accessibilityLabel(L.t("native_terminal_prompt_send"))
            .accessibilityIdentifier("terminal-reply-send")
        }
        .padding(8).padding(.leading, 8)
        .background(ComposePalette.panel, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(ComposePalette.line))
    }

    @ViewBuilder private var restingBackground: some View {
        if #available(iOS 26.0, *), !rendersStaticFixture {
            Capsule().fill(ComposePalette.panel.opacity(0.7)).glassEffect(.regular, in: Capsule())
        } else { Capsule().fill(ComposePalette.panel) }
        Capsule().stroke(ComposePalette.line)
            .shadow(color: ComposePalette.bg.opacity(0.45), radius: 8, y: 4)
    }

    private var attachMenu: some View {
        Menu {
            Button(L.t("native_ios_attachment_photos"), systemImage: "photo.on.rectangle") { photos = true }
            Button(L.t("native_ios_attachment_camera"), systemImage: "camera") { camera = true }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            Button(L.t("native_ios_attachment_files"), systemImage: "doc") { files = true }
        } label: { Image(systemName: "paperclip").frame(width: 44, height: 44) }
        .disabled(!model.canAttach)
        .accessibilityLabel(L.t("newtask_attach_aria"))
        .accessibilityIdentifier("terminal-attach")
    }

    private var accessoryKeys: some View {
        Group {
            if rendersStaticFixture {
                Color.clear.frame(height: 44).overlay(alignment: .leading) { accessoryKeyRow.fixedSize() }.clipped()
            } else { ScrollView(.horizontal) { accessoryKeyRow }.scrollIndicators(.hidden) }
        }
    }
    private var accessoryKeyRow: some View {
        HStack(spacing: 0) {
            ForEach([IOSTerminalKey.escape, .tab, .ctrlC, .up, .down], id: \.self) { key in
                Button { model.sendKey(key) } label: {
                    Text(verbatim: key == .escape || key == .tab ? key.keycap.lowercased() : key.keycap)
                        .font(.system(.caption, design: .monospaced)).frame(minWidth: 44, minHeight: 44)
                }.accessibilityLabel(key.accessibilityLabel).disabled(!model.canSendInput)
            }
            Menu {
                ForEach(IOSTerminalKey.allCases, id: \.self) { key in
                    Button(key.accessibilityLabel) { model.sendKey(key) }.disabled(!model.canSendInput)
                }
            } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                .accessibilityLabel(L.t("controlbar_toolbar_aria"))
        }
    }

    @ViewBuilder private var microphone: some View {
        if let voice = model.voice {
            HoldToTalkButton(voice: voice, compact: true, plainCompact: model.showsWriting,
                rendersStaticFixture: rendersStaticFixture,
                enabled: model.canRecordReply && voice.state != .finalizing, canBegin: { model.canRecordReply })
                .disabled(!model.canRecordReply || voice.state == .finalizing)
                .contextMenu {
                    Button("DE") { voice.locale = "de-DE" }
                    Button("EN") { voice.locale = "en-US" }
                }
                .accessibilityAction(named: L.t("native_compose_voice_language") + " DE") { voice.locale = "de-DE" }
                .accessibilityAction(named: L.t("native_compose_voice_language") + " EN") { voice.locale = "en-US" }
        } else {
            Image(systemName: "mic.fill").frame(width: 44, height: 44)
                .foregroundStyle(model.showsWriting ? ComposePalette.amber : ComposePalette.bg)
                .background { if !model.showsWriting { Circle().fill(ComposePalette.amber) } }
                .accessibilityHidden(true)
        }
    }
    private func hideKeyboard() { focused = false; model.closeWriting() }

    private func recordingStatus(_ voice: DictationController) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if voice.capturing {
                HStack(spacing: 10) {
                    WaveformView(level: voice.level, cancelled: voice.state == .cancelling)
                    Text(verbatim: String(format: "%02d:%02d", Int(voice.elapsed) / 60, Int(voice.elapsed) % 60))
                        .monospacedDigit()
                    if voice.state == .locked { Image(systemName: "lock.fill") }
                }.foregroundStyle(ComposePalette.ink).accessibilityIdentifier("terminal-reply-recording")
            }
            Text(L.t(hintKey(voice))).foregroundStyle(ComposePalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if voice.state == .recording {
                Label(L.t("native_compose_voice_cancel_swipe"), systemImage: "chevron.left")
                    .foregroundStyle(ComposePalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !voice.preview.isEmpty {
                Text(verbatim: voice.preview).lineLimit(4)
                    .strikethrough(voice.state == .cancelling)
                    .foregroundStyle(voice.state == .cancelling ? ComposePalette.faint : ComposePalette.ink)
                    .accessibilityIdentifier("terminal-reply-preview")
            }
        }.font(.system(.caption, design: .monospaced))
    }

    private func hintKey(_ voice: DictationController) -> StaticString {
        switch voice.state {
        case .locked: "native_compose_voice_locked"
        case .cancelling: "native_compose_voice_discard"
        case .recording: "native_compose_voice_hint"
        case .finalizing: "native_compose_voice_finalize"
        default: "native_compose_voice_preparing"
        }
    }
}
