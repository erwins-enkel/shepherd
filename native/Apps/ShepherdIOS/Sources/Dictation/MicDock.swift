import SwiftUI
import UIKit
import ShepherdAppCore

struct WaveformView: View {
    let level: Float
    let cancelled: Bool
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<24, id: \.self) { index in
                Capsule().fill(cancelled ? ComposePalette.faint : ComposePalette.red)
                    .frame(width: 4, height: max(4, CGFloat(level) * CGFloat([12,24,17,8,20,26][index % 6])))
            }
        }.frame(height: 26).accessibilityHidden(true)
    }
}
struct TranscriptPreview: View {
    @Bindable var voice: DictationController
    var audioEngine: IOSDictationEngine? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if voice.state != .cancelling && voice.livePreviewAvailable {
                Text(verbatim: L.t("native_compose_voice_live").uppercased()).font(.system(.caption2, design: .monospaced)).tracking(1.2).foregroundStyle(ComposePalette.red)
            }
            Text(verbatim: voice.preview.isEmpty && !voice.livePreviewAvailable ? L.t(audioEngine?.recordingHintKey ?? "native_compose_voice_recording") : voice.preview).foregroundStyle(voice.state == .cancelling ? ComposePalette.faint : ComposePalette.ink)
                .strikethrough(voice.state == .cancelling).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(12).background(ComposePalette.panel2)
            .overlay(alignment: .leading) { Rectangle().fill(voice.state == .cancelling ? ComposePalette.faint : ComposePalette.red).frame(width: 2) }
            .accessibilityIdentifier("compose.voice.preview")
    }
}
struct HoldToTalkButton: View {
    @Bindable var voice: DictationController
    // Compact terminal control keeps the composer's gesture and feedback unchanged.
    var compact = false
    var plainCompact = false
    var rendersStaticFixture = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var enabled = true
    var canBegin: () -> Bool = { true }
    @Environment(\.scenePhase) private var scenePhase
    @State private var hold = IOSDictationHold()
    @State private var hint = false
    var body: some View {
        accessibleButton
            .onChange(of: voice.state) { old, state in feedback(old, state) }
            .overlay(alignment: .top) {
                if hint {
                    Text(verbatim: L.t("native_compose_voice_hint")).font(.system(.caption, design: .monospaced))
                        .padding(8).background(ComposePalette.panel2).fixedSize(horizontal: false, vertical: true).offset(y: -90)
                }
            }
            .task(id: hint) { if hint { try? await Task.sleep(for: .seconds(3)); hint = false } }
            .onChange(of: enabled) { _, enabled in if !enabled { hold.cancel() } }
            .onChange(of: scenePhase) { _, phase in if !rendersStaticFixture && phase != .active { hold.cancel() } }
            .onDisappear { hold.cancel() }
    }
    private var accessibleButton: some View {
        Button { if eligible { voice.toggle() } } label: { microphone }
            .buttonStyle(.plain).highPriorityGesture(holdGesture)
            .accessibilityLabel(voice.state == .locked ? L.t("native_compose_voice_stop") : L.t("native_compose_voice_label"))
            .accessibilityValue(voice.capturing ? L.t("native_compose_voice_recording") : L.t("native_compose_voice_ready"))
            .accessibilityHint(L.t("native_compose_voice_hint"))
            .accessibilityAddTraits(.startsMediaSession)
            .accessibilityAction { if eligible { voice.toggle() } }
            .accessibilityAction(named: L.t("common_cancel")) { voice.cancel() }
            .accessibilityAction(named: L.t("native_compose_voice_lock")) { voice.drag(x: 0, y: -60) }
            .accessibilityIdentifier(voice.state == .locked ? "compose.voice.stop" : "compose.voice.mic.\(voice.state.rawValue)")
    }
    private var microphone: some View {
        Group {
            if compact {
                ZStack {
                    if (voice.state == .arming || voice.state == .finalizing) && rendersStaticFixture { Image(systemName: "hourglass") }
                    else if voice.state == .arming || voice.state == .finalizing { ProgressView().tint(plainCompact ? ComposePalette.amber : ComposePalette.bg) }
                    else { Image(systemName: voice.state == .locked ? "stop.fill" : "mic.fill").font(.system(.title3)) }
                }
                .frame(width: IOSTerminalMicStyle.diameter, height: IOSTerminalMicStyle.diameter)
                .foregroundStyle(plainCompact ? ComposePalette.amber : ComposePalette.bg)
                .background(Circle().fill(plainCompact ? Color.clear : ComposePalette.amber))
                .scaleEffect(IOSTerminalMicStyle.scale(held: hold.holding || voice.state == .recording, reduceMotion: reduceMotion))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: hold.holding || voice.state == .recording)

            } else { composerMicrophone }
        }
    }
    private var composerMicrophone: some View {
        ZStack {
            if !voice.canUndo && voice.state != .cancelling { Circle().fill(fill.opacity(0.15)).padding(-6) }
            if voice.state == .recording && !reduceMotion { Circle().stroke(fill.opacity(0.12), lineWidth: 8).padding(-14) }
            Circle().fill(voice.canUndo ? ComposePalette.panel : fill)
                .overlay(Circle().stroke(voice.canUndo ? ComposePalette.amber : Color.clear))
            if voice.state == .arming || voice.state == .finalizing { ProgressView().tint(ComposePalette.bg) }
            else { Image(systemName: symbol).font(.system(size: 30, weight: .medium)) }
        }.frame(width: diameter, height: diameter).foregroundStyle(foreground)
    }
    private var eligible: Bool { enabled && canBegin() && (rendersStaticFixture || scenePhase == .active) }
    private var holdGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global).onChanged { value in
            if !hold.holding, eligible { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
            hold.changed(voice: voice, translation: value.translation, eligible: { eligible })
        }.onEnded { _ in hold.ended(voice: voice, eligible: eligible) }
    }
    private func feedback(_ old: DictationController.State, _ state: DictationController.State) {
        if state == .locked { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
        if state == .cancelling, old != .cancelling { UISelectionFeedbackGenerator().selectionChanged() }
        if state == .recording, old == .arming { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
        if state == .idle, old == .finalizing {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            AccessibilityNotification.Announcement(L.t("native_compose_voice_kept")).post()
        }
        if [.locked, .denied, .error, .unsupported].contains(state) {
            AccessibilityNotification.Announcement(state == .locked ? L.t("native_compose_voice_locked") : voice.noticeCopy ?? L.t("native_compose_voice_error")).post()
        }
    }
    private var symbol: String { voice.state == .locked ? "stop.fill" : voice.state == .denied ? "mic.slash" : "mic" }
    private var diameter: CGFloat { voice.state == .recording ? 104 : voice.canUndo || voice.state == .cancelling ? 72 : 84 }
    private var foreground: Color { voice.canUndo ? ComposePalette.amber : voice.capturing ? .white : ComposePalette.bg }
    private var fill: Color {
        switch voice.state {
        case .recording, .locked: ComposePalette.red
        case .cancelling, .denied, .unsupported: ComposePalette.slate
        default: ComposePalette.amber
        }
    }
}
struct MicDock<Attachment: View, Submit: View>: View {
    @Bindable var voice: DictationController
    let audioEngine: IOSDictationEngine?
    let micEnabled: Bool
    let attachment: Attachment
    let submit: Submit
    @Environment(\.dynamicTypeSize) private var typeSize
    init(voice: DictationController, audioEngine: IOSDictationEngine? = nil, micEnabled: Bool = true, @ViewBuilder attachment: () -> Attachment, @ViewBuilder submit: () -> Submit) {
        self.voice = voice; self.audioEngine = audioEngine; self.micEnabled = micEnabled; self.attachment = attachment(); self.submit = submit()
    }
    var body: some View {
        VStack(spacing: 12) {
            recordingInfo
            // Keep this control mounted at one identity for the entire drag. Replacing the
            // idle row with a recording row cancels SwiftUI's gesture before release/lock.
            ZStack {
                if !typeSize.isAccessibilitySize || voice.capturing {
                    HStack {
                        leftControl
                        Spacer()
                        rightControl
                    }
                }
                HoldToTalkButton(voice: voice, enabled: micEnabled)
                    .disabled(!micEnabled)
                    .opacity(voice.state == .unsupported ? 0 : micEnabled ? 1 : 0.4)
                    .allowsHitTesting(voice.state != .unsupported)
                    .accessibilityHidden(voice.state == .unsupported)
                    .offset(x: voice.state == .cancelling ? 120 : 0)
            }.frame(height: voice.state == .recording ? 104 : 84)
            if typeSize.isAccessibilitySize && !voice.capturing {
                HStack { attachment; Spacer(); submit }
            }
            if !voice.canUndo {
                Text(verbatim: L.t(hintKey)).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ComposePalette.muted).multilineTextAlignment(.center)
            }
        }.padding(.horizontal, 24).padding(.top, 12)
            .accessibilityElement(children: .contain).accessibilityIdentifier("compose.voice.dock")
    }
    @ViewBuilder private var recordingInfo: some View {
        if voice.capturing {
            if voice.state == .recording {
                HStack {
                    Label(L.t("native_compose_voice_cancel_swipe"), systemImage: "chevron.left")
                    Spacer()
                    Label(L.t("native_compose_voice_lock"), systemImage: "lock")
                }.font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.muted)
            }
            HStack(spacing: 12) {
                WaveformView(level: voice.level, cancelled: voice.state == .cancelling)
                Text(verbatim: String(format: "%02d:%02d", Int(voice.elapsed) / 60, Int(voice.elapsed) % 60)).monospacedDigit()
                    .accessibilityIdentifier("compose.voice.elapsed")
                if voice.state == .locked { Image(systemName: "lock.fill") }
                Spacer(minLength: 0)
            }.font(.system(.caption, design: .monospaced)).foregroundStyle(ComposePalette.bright)
        }
    }
    @ViewBuilder private var leftControl: some View {
        if voice.state == .locked {
            Button(L.t("common_cancel")) { voice.cancel() }.foregroundStyle(ComposePalette.red).frame(minWidth: 44, minHeight: 44)
        } else if voice.state == .cancelling {
            HStack(spacing: 12) {
                Image(systemName: "trash").font(.title2).foregroundStyle(ComposePalette.red).frame(width: 48, height: 48)
                    .overlay(Circle().stroke(ComposePalette.red, lineWidth: 2))
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: L.t("native_compose_voice_discard")).foregroundStyle(ComposePalette.red)
                    Text(verbatim: L.t("native_compose_voice_slide_back")).font(.system(.caption2, design: .monospaced)).foregroundStyle(ComposePalette.muted)
                }
            }.frame(maxWidth: 250, alignment: .leading).padding(.trailing, 72)
        } else { attachment.opacity(voice.active ? 0 : 1).allowsHitTesting(!voice.active).accessibilityHidden(voice.active) }
    }
    @ViewBuilder private var rightControl: some View {
        if voice.state == .locked {
            Button(L.t("native_compose_voice_done")) { voice.finalize() }.foregroundStyle(ComposePalette.amber).frame(minWidth: 44, minHeight: 44)
        } else { submit.opacity(voice.active ? 0 : 1).allowsHitTesting(!voice.active).accessibilityHidden(voice.active) }
    }
    var hintKey: StaticString {
        switch voice.state {
        case .arming: voice.preparing ? "native_compose_voice_preparing" : "native_compose_voice_hold"
        case .finalizing: "native_compose_voice_finalize"
        case .recording: audioEngine?.recordingHintKey ?? (voice.preparing ? "native_compose_voice_preparing" : voice.livePreviewAvailable ? "native_compose_voice_no_send" : "native_compose_voice_recording")
        case .locked: voice.preparing ? "native_compose_voice_preparing" : "native_compose_voice_locked"
        case .cancelling: "native_compose_voice_unchanged"
        default: "native_compose_voice_hold"
        }
    }
}
