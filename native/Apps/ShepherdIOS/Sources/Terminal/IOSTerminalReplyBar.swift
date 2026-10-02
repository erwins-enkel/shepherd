import ShepherdAppCore
import SwiftUI
import UIKit

/// The terminal draft is always visible. Dictation only edits it; Send is explicit.
struct IOSTerminalReplyBar: View {
    let model: IOSTerminalPresentation
    var rendersStaticFixture = false
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        @Bindable var session = model.session
        VStack(alignment: .leading, spacing: 8) {
            if let voice = model.voice, voice.active {
                recordingStatus(voice)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Group {
                    if rendersStaticFixture {
                        Text(verbatim: session.promptText.isEmpty ? L.t("native_terminal_prompt_placeholder") : session.promptText)
                            .foregroundStyle(session.promptText.isEmpty ? ComposePalette.muted : ComposePalette.ink)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    } else {
                        TextField(L.t("native_terminal_prompt_placeholder"), text: $session.promptText, axis: .vertical)
                            .lineLimit(1...5)
                            .focused($focused)
                            .frame(minHeight: 44)
                            .disabled(!model.canRecordReply || model.voice?.active == true)
                    }
                }
                .padding(.horizontal, 10)
                .background(IOSTerminalStyle.background)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(ComposePalette.line))
                .accessibilityLabel(L.t("native_terminal_prompt_placeholder"))
                .accessibilityIdentifier("terminal-reply-text")
                if !session.promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button { focused = false; Task { _ = await model.submitReply() } } label: {
                        Group {
                            if model.replying && rendersStaticFixture { Image(systemName: "hourglass") }
                            else if model.replying { ProgressView() }
                            else { Image(systemName: "arrow.up") }
                        }.frame(width: 44, height: 48)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ComposePalette.amber)
                    .overlay(RoundedRectangle(cornerRadius: 2).stroke(ComposePalette.line))
                    .disabled(!model.canSubmitReply)
                    .accessibilityLabel(L.t(model.replying ? "common_loading" : "native_terminal_prompt_send"))
                    .accessibilityIdentifier("terminal-reply-send")
                }
                if let voice = model.voice, !voice.active, session.promptText.isEmpty {
                    languageControl(voice)
                }
                // This identity survives every recording state and draft change.
                if let voice = model.voice {
                    HoldToTalkButton(voice: voice, compact: true, rendersStaticFixture: rendersStaticFixture,
                        enabled: model.canRecordReply && voice.state != .finalizing, canBegin: { model.canRecordReply })
                        .disabled(!model.canRecordReply || voice.state == .finalizing)
                } else {
                    Image(systemName: "mic").frame(width: 48, height: 48)
                        .foregroundStyle(ComposePalette.faint).accessibilityHidden(true)
                }
            }
            if let voice = model.voice {
                // The hold hint lives on the microphone's VoiceOver hint now; this row only
                // appears when there is something to undo or cancel.
                if voice.canUndo || voice.state == .locked {
                    HStack(alignment: .top, spacing: 8) {
                        if voice.canUndo {
                            Button(L.t("native_compose_voice_undo")) { voice.undo() }
                                .frame(minHeight: 44).disabled(model.replying)
                        } else {
                            Button(L.t("common_cancel")) { voice.cancel() }.frame(minHeight: 44)
                        }
                        Spacer(minLength: 0)
                    }.font(.system(.caption, design: .monospaced))
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
            if let error = model.replyError {
                Text(verbatim: error).foregroundStyle(ComposePalette.red)
                    .accessibilityIdentifier("terminal-reply-error")
            }
        }
        .font(.system(.callout, design: .monospaced))
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(ComposePalette.panel)
        .accessibilityElement(children: .contain).accessibilityIdentifier("terminal-reply-bar")
        .onAppear { model.prepareDictation() }
        .onChange(of: model.voice?.active) { _, active in if active == true { focused = false } }
        .onChange(of: model.canRecordReply) { _, canSend in if !rendersStaticFixture && !canSend { focused = false; model.suspendDictation() } }
        .onChange(of: scenePhase) { _, phase in if !rendersStaticFixture && phase != .active { focused = false; model.suspendDictation() } }
        .onDisappear { if !rendersStaticFixture { focused = false; model.suspendDictation() } }
        .alert(L.t("native_compose_voice_label"), isPresented: Binding(
            get: { model.audioEngine?.needsAppleServerConsent == true },
            set: { if !$0 { model.audioEngine?.resolveAppleServerConsent(false) } })) {
                Button(L.t("native_compose_voice_allow")) { model.audioEngine?.resolveAppleServerConsent(true) }
                Button(L.t("common_cancel"), role: .cancel) { model.audioEngine?.resolveAppleServerConsent(false) }
            } message: { Text(L.t("native_compose_voice_apple_disclosure")) }
    }

    @ViewBuilder private func languageControl(_ voice: DictationController) -> some View {
        if rendersStaticFixture { languageLabel(voice) }
        else {
            Menu {
                Button("DE") { voice.locale = "de-DE" }
                Button("EN") { voice.locale = "en-US" }
            } label: { languageLabel(voice) }
                .disabled(model.replying)
                .accessibilityLabel(L.t("native_compose_voice_language"))
                .accessibilityHint(L.t("native_compose_voice_hold"))
        }
    }

    private func languageLabel(_ voice: DictationController) -> some View {
        Text(verbatim: voice.locale.hasPrefix("de") ? "DE" : "EN")
            .font(.system(.caption, design: .monospaced))
            .frame(minWidth: 36, minHeight: 44).foregroundStyle(ComposePalette.muted)
    }

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
