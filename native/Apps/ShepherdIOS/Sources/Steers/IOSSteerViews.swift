import ShepherdAppCore
import ShepherdKit
import SwiftUI
import UIKit

extension ComposeSteer {
    var chipTitle: String { [emoji, label].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " ") }
}

/// Favourite steers directly above the reply draft, plus the entry to the full panel.
/// The swipe-left gesture opens the same panel; this row is the discoverable path.
struct IOSSteerChips: View {
    let steers: [ComposeSteer]
    let terminal: IOSTerminalPresentation
    let openAll: () -> Void
    /// ScrollView is UIKit-backed and does not draw into ImageRenderer.
    var rendersStaticFixture = false
    @State private var sentID: String?

    var body: some View {
        Group {
            if rendersStaticFixture {
                Color.clear.frame(height: 44).overlay(alignment: .leading) { chipRow.fixedSize() }.clipped()
            } else { ScrollView(.horizontal) { chipRow }.scrollIndicators(.hidden) }
        }
        .font(.system(.subheadline))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("steerbar_toolbar_aria"))
        .accessibilityIdentifier("steer-chips")
    }

    private var chipRow: some View {
        HStack(spacing: 6) {
            ForEach(steers, id: \.id) { steer in chip(steer) }
            Button(action: openAll) {
                Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44)
            }
            .buttonStyle(.plain).foregroundStyle(ComposePalette.ink)
            .accessibilityLabel(L.t("native_ios_steers_all"))
            .accessibilityIdentifier("steer-open-panel")
        }
    }

    private func chip(_ steer: ComposeSteer) -> some View {
        Button {
            Task {
                guard await terminal.sendSteer(steer.text) else { return }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                sentID = steer.id
                try? await Task.sleep(for: .seconds(1.5))
                if sentID == steer.id { sentID = nil }
            }
        } label: {
            HStack(spacing: 5) {
                if sentID == steer.id { Image(systemName: "checkmark") }
                Text(verbatim: steer.chipTitle).lineLimit(1)
            }
            .padding(.horizontal, 12).frame(height: 32)
            .background(ComposePalette.panel2, in: Capsule())
            .overlay(Capsule().stroke(sentID == steer.id ? ComposePalette.green : ComposePalette.line))
        }
        .buttonStyle(.plain)
        .foregroundStyle(sentID == steer.id ? ComposePalette.green : ComposePalette.ink)
        .frame(minHeight: 44)
        .disabled(!terminal.canSendSteer)
        .accessibilityLabel(L.t("steerbar_send_aria", steer.label))
        .accessibilityIdentifier("steer-chip-\(steer.id)")
    }
}

/// The panel a left swipe reveals: every steer of this session's bar, the two
/// interrupting keys and the session lifecycle. Decommissioning needs a hold before
/// its sheet opens, so the swipe that opened the panel can never start it by accident.
struct IOSSteerPanel: View {
    let session: Session
    let steers: [ComposeSteer]
    let loadError: String?
    let terminal: IOSTerminalPresentation
    /// Opens the decommission sheet; nil while writes are not allowed (read-only, wrong
    /// activation, archived).
    let decommission: (() -> Void)?
    let close: () -> Void
    var rendersStaticFixture = false
    @State private var sendingID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if rendersStaticFixture { panelBody; Spacer(minLength: 0) }
            else { ScrollView { panelBody }.scrollIndicators(.hidden) }
            Label(L.t("native_ios_steers_swipe_hint"), systemImage: "arrow.right")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ComposePalette.faint)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(ComposePalette.panel)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 24, bottomLeadingRadius: 24))
        .overlay(UnevenRoundedRectangle(topLeadingRadius: 24, bottomLeadingRadius: 24).stroke(ComposePalette.line))
        .foregroundStyle(ComposePalette.ink)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("steer-panel")
        .accessibilityAction(.escape) { close() }
    }

    private var panelBody: some View {
        VStack(alignment: .leading, spacing: 18) {
            steerGrid
            if let error = terminal.replyError {
                Text(verbatim: error).foregroundStyle(ComposePalette.red)
                    .accessibilityIdentifier("steer-panel-error")
            }
            terminalKeys
            sessionSection
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L.t("native_ios_steers_title")).font(.system(.title3, design: .default).weight(.semibold))
                    .foregroundStyle(ComposePalette.bright)
                Text(verbatim: session.name).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ComposePalette.muted).lineLimit(1)
            }
            Spacer()
            Button(action: close) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                .buttonStyle(.plain).foregroundStyle(ComposePalette.muted)
                .accessibilityLabel(L.t("common_close"))
                .accessibilityIdentifier("steer-panel-close")
        }
    }

    @ViewBuilder private var steerGrid: some View {
        if steers.isEmpty {
            Text(verbatim: loadError ?? L.t("native_ios_steers_empty"))
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(loadError == nil ? ComposePalette.muted : ComposePalette.red)
        } else {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8, alignment: .top),
                                GridItem(.flexible(), spacing: 8, alignment: .top)], spacing: 8) {
                ForEach(steers, id: \.id) { steer in tile(steer) }
            }
        }
    }

    private func tile(_ steer: ComposeSteer) -> some View {
        Button {
            sendingID = steer.id
            Task {
                let sent = await terminal.sendSteer(steer.text)
                sendingID = nil
                if sent {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    close()
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(verbatim: steer.chipTitle).font(.system(.callout).weight(.semibold))
                        .foregroundStyle(ComposePalette.bright).lineLimit(2)
                    Spacer(minLength: 0)
                    if sendingID == steer.id { ProgressView().controlSize(.small) }
                }
                Text(verbatim: steer.text).font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(ComposePalette.faint).lineLimit(1)
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 66, alignment: .topLeading)
            .background(ComposePalette.panel2, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(ComposePalette.line))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(!terminal.canSendSteer)
        .accessibilityLabel(L.t("steerbar_send_aria", steer.label))
        .accessibilityHint(steer.text)
        .accessibilityIdentifier("steer-tile-\(steer.id)")
    }

    private var terminalKeys: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle(L.t("native_ios_steers_section_terminal"))
            HStack(spacing: 8) {
                ForEach([IOSTerminalKey.escape, .ctrlC, .tab], id: \.self) { key in
                    Button { terminal.sendKey(key) } label: {
                        Text(verbatim: key.keycap).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(ComposeControlStyle())
                    .font(.system(.callout, design: .monospaced))
                    .disabled(!terminal.canSendInput)
                    .accessibilityLabel(key.accessibilityLabel)
                    .accessibilityIdentifier("steer-key-\(key)")
                }
            }
        }
    }

    @ViewBuilder private var sessionSection: some View {
        let state = terminal.actionState
        let lifecycle = (state?.actions ?? []).filter { $0 == .stop || $0 == .resume }
        if !lifecycle.isEmpty || decommission != nil {
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle(L.t("native_ios_steers_section_session"))
                if let state {
                    ForEach(lifecycle, id: \.self) { action in
                        Button { Task { await state.execute(action) } } label: {
                            Label(IOSSessionActionState.label(action, session: session), systemImage: action.systemImage)
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(ComposeControlStyle())
                        .disabled(!state.allowsWrites || state.busy)
                        .accessibilityIdentifier("steer-action-\(action.id)")
                    }
                    if let error = state.error { Text(verbatim: error).foregroundStyle(ComposePalette.red) }
                }
                if let decommission {
                    IOSHoldToConfirmButton(title: L.t("native_ios_steers_end_hold"), confirm: decommission)
                        .accessibilityIdentifier("steer-end-session")
                }
            }
            .font(.system(.callout, design: .monospaced))
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(verbatim: title.uppercased())
            .font(.system(.caption, design: .monospaced).weight(.semibold))
            .foregroundStyle(ComposePalette.muted)
    }
}

/// Fills while held; fires once the hold completes. VoiceOver cannot hold, so its
/// activation fires at once — what it opens has to be a confirmation of its own.
struct IOSHoldToConfirmButton: View {
    let title: String
    let confirm: () -> Void
    var duration = 1.2
    @State private var progress: CGFloat = 0

    var body: some View {
        Text(verbatim: title).font(.system(.callout).weight(.semibold))
        .foregroundStyle(ComposePalette.red)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(alignment: .leading) {
            GeometryReader { geometry in
                ComposePalette.red.opacity(0.22).frame(width: geometry.size.width * progress)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(ComposePalette.red.opacity(0.7)))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onLongPressGesture(minimumDuration: duration, maximumDistance: 40) {
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            withAnimation(.easeOut(duration: 0.2)) { progress = 0 }
            confirm()
        } onPressingChanged: { pressing in
            if pressing { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
            withAnimation(pressing ? .linear(duration: duration) : .easeOut(duration: 0.2)) {
                progress = pressing ? 1 : 0
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { confirm() }
    }
}
