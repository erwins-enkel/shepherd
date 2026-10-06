import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Saved quick prompts use /reply; the emulator owns ordinary keyboard input.
struct TerminalSteerFooter: View {
    let store: SessionStore
    let sessionID: String
    let app: AppModel
    let activation: Int
    @State private var library = SteerLibrary()
    @State private var delivery = SteerSendState()
    @State private var command = SessionCommandState()
    @State private var allOpen = false
    @State private var editor: ComposeActions.Action?
    @State private var search = ""
    @FocusState private var searchFocused: Bool

    private var session: Session? { store.session(id: sessionID) }
    private var current: Bool {
        app.store === store && app.activationGeneration == activation
            && app.selectedSessionID == sessionID
    }
    // Same write block as iOS, including the isolated-mode request audit (#2418).
    private var allowsWrites: Bool {
        current && app.allowsTerminalInput && app.liveRequestAudit == nil
            && session.map { $0.status.known != .archived } == true
    }
    private var canSend: Bool { allowsWrites && delivery.sendingID == nil }
    private var steers: [ComposeSteer] { session.map { library.barSteers(for: $0) } ?? [] }
    private var matches: [ComposeSteer] { SteerShortcuts.matches(steers, search: search) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let session { statusRow(session) }
            HStack(spacing: 8) {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(steers, id: \.id) { steer in
                            chip(steer).modifier(SteerShortcut(number: allOpen ? nil : shortcut(steer)))
                        }
                        if steers.isEmpty {
                            Text(L.t("native_mac_steers_empty")).foregroundStyle(.secondary)
                        }
                    }.frame(minHeight: 32)
                }
                .scrollIndicators(.hidden)
                .fixedSize(horizontal: false, vertical: true)
                Button { search = ""; allOpen.toggle() } label: {
                    HStack(spacing: 6) {
                        Text(L.t("native_ios_steers_all"))
                        keycap("⌘J")
                    }.frame(minHeight: 32)
                }
                .keyboardShortcut("j", modifiers: .command)
                .accessibilityIdentifier("terminal-steers-all")
                .popover(isPresented: $allOpen, arrowEdge: .top) { popover }
                Button { openEditor(.steers) } label: {
                    Image(systemName: "pencil").frame(width: 32, height: 32)
                }
                .help(L.t("steerbar_edit"))
                .accessibilityLabel(L.t("steerbar_edit"))
                .accessibilityIdentifier("terminal-steers-edit")
                .disabled(!allowsWrites)
            }
            sendError
            if let error = library.loadError {
                HStack {
                    Text(verbatim: error).foregroundStyle(ShepherdPalette.red)
                    Button(L.t("common_retry")) { Task { await load() } }
                }.font(.caption)
            }
            Text(L.t("native_mac_steers_hint"))
                .font(.caption).foregroundStyle(.tertiary)
                .accessibilityIdentifier("terminal-steers-hint")
        }
        .font(.callout)
        .foregroundStyle(ShepherdPalette.ink)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(ShepherdPalette.panel)
        .sheet(item: $editor, onDismiss: { Task { await load() } }) { mode in
            ComposeActionSheet(mode: mode, session: session, store: store, app: app, activation: activation)
        }
        .task { await load() }
        .onDisappear { allOpen = false; delivery.reset(); command.clear() }
    }

    private func statusRow(_ session: Session) -> some View {
        let recap = app.extension(ActionsModel.self)?.recap(for: sessionID)
        return HStack(spacing: 8) {
            if let content = RecapLine.content(for: recap) {
                if !content.verdict.isEmpty {
                    let tint = ShepherdPalette.badgeTint(RecapLine.tint(for: recap?.verdict))
                    Text(verbatim: content.verdict.uppercased()).font(.caption.weight(.semibold))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .foregroundStyle(tint).background(tint.opacity(0.12), in: Capsule())
                }
                Text(verbatim: content.headline).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 8)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let parts = [SessionStatusStyle.providerLabel(session.agentProvider),
                    session.runtimeModel ?? session.model,
                    (session.runtimeEffort ?? session.effort).map { EffortPicker.label($0) },
                    RepoRecency.age(session.createdAt, now: context.date)]
                Text(verbatim: parts.compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    .layoutPriority(1)
            }
        }.accessibilityIdentifier("terminal-steers-status")
    }

    private func shortcut(_ steer: ComposeSteer) -> Int? { SteerShortcuts.number(for: steer.id, in: steers) }

    private func keycap(_ text: String) -> some View {
        Text(verbatim: text).font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ShepherdPalette.muted)
            .padding(.horizontal, 3).padding(.vertical, 1)
            .background(ShepherdPalette.panel2, in: RoundedRectangle(cornerRadius: 3))
            .overlay { RoundedRectangle(cornerRadius: 3).stroke(ShepherdPalette.line) }
            .accessibilityHidden(true)
    }

    @ViewBuilder private func feedback(_ steer: ComposeSteer) -> some View {
        switch delivery.phase(for: steer.id) {
        case .sending: ProgressView().controlSize(.mini)
        case .sent: Image(systemName: "checkmark").foregroundStyle(ShepherdPalette.green)
        case .idle, .failed: EmptyView()
        }
    }

    private func stroke(_ steer: ComposeSteer) -> Color {
        switch delivery.phase(for: steer.id) {
        case .sent: ShepherdPalette.green
        case .failed: ShepherdPalette.red
        default: ShepherdPalette.lineBright
        }
    }

    private func chip(_ steer: ComposeSteer) -> some View {
        Button { send(steer) } label: {
            HStack(spacing: 6) {
                feedback(steer)
                Text(verbatim: steer.chipTitle).lineLimit(1)
                if let number = shortcut(steer) { keycap("⌘\(number)") }
            }
            .padding(.horizontal, 10).frame(minHeight: 32)
            .background(ShepherdPalette.panel2, in: Capsule())
            .overlay { Capsule().stroke(stroke(steer)) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain).help(steer.text)
        .disabled(!canSend)
        .accessibilityLabel(L.t("steerbar_send_aria", steer.label))
        .accessibilityIdentifier("terminal-steer-\(steer.id)")
    }

    @ViewBuilder private var sendError: some View {
        if let id = delivery.failedID, case .failed(let error) = delivery.phase(for: id) {
            HStack {
                Text(verbatim: error).foregroundStyle(ShepherdPalette.red)
                if let steer = steers.first(where: { $0.id == id }) {
                    Button(L.t("native_mac_steers_retry")) { send(steer) }.disabled(!canSend)
                        .accessibilityIdentifier("terminal-steer-retry")
                }
            }.font(.caption).accessibilityIdentifier("terminal-steer-error")
        }
    }

    private var popover: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L.t("native_ios_steers_title")).font(.headline)
                if let session { Text(verbatim: session.name).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                Button { allOpen = false } label: { Image(systemName: "xmark").frame(width: 28, height: 28) }
                    .accessibilityLabel(L.t("common_close")).keyboardShortcut(.cancelAction)
            }
            TextField(L.t("native_mac_steers_search"), text: $search)
                .textFieldStyle(.roundedBorder).focused($searchFocused)
                .onSubmit { if let first = matches.first { send(first) } }
                .accessibilityIdentifier("terminal-steers-search")
            ScrollView {
                if steers.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: library.loadError ?? L.t("native_mac_steers_empty"))
                            .foregroundStyle(library.loadError == nil ? ShepherdPalette.muted : ShepherdPalette.red)
                        Button(L.t("native_mac_steers_create")) { openEditor(.steers) }.disabled(!allowsWrites)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                } else if matches.isEmpty {
                    Text(L.t("native_mac_steers_no_matches")).foregroundStyle(.secondary)
                } else {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                        ForEach(matches, id: \.id) { steer in tile(steer) }
                    }
                }
            }.frame(maxHeight: 300)
            sendError
            if let error = library.loadError, !steers.isEmpty {
                Text(verbatim: error).font(.caption).foregroundStyle(ShepherdPalette.red)
            }
            sessionActions
            Divider()
            Button(L.t("steerbar_edit")) { openEditor(.steers) }.disabled(!allowsWrites)
        }
        .buttonStyle(.borderless)
        .padding(16).frame(width: 540)
        .foregroundStyle(ShepherdPalette.ink).background(ShepherdPalette.panel)
        .onAppear { searchFocused = true }
        .accessibilityIdentifier("terminal-steers-popover")
    }

    private func tile(_ steer: ComposeSteer) -> some View {
        Button { send(steer) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(verbatim: steer.chipTitle).bold().lineLimit(1)
                    Spacer(minLength: 0)
                    feedback(steer)
                    if let number = shortcut(steer) { keycap("⌘\(number)") }
                }
                Text(verbatim: steer.text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(10).frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .background(ShepherdPalette.panel2, in: RoundedRectangle(cornerRadius: 8))
            .overlay { RoundedRectangle(cornerRadius: 8).stroke(stroke(steer)) }
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain).help(steer.text).disabled(!canSend)
        .accessibilityLabel(L.t("steerbar_send_aria", steer.label))
        .accessibilityIdentifier("terminal-steer-tile-\(steer.id)")
        .modifier(SteerShortcut(number: shortcut(steer)))
    }

    @ViewBuilder private var sessionActions: some View {
        if let session, allowsWrites {
            Divider()
            Text(L.t("native_ios_steers_section_session")).font(.caption).foregroundStyle(.secondary)
            HStack {
                if app.extension(ActionsModel.self)?.actions(for: session).contains(.stop) == true {
                    Button(SessionAction.stop.label(for: session)) {
                        Task {
                            await command.run({ try await store.interrupt(id: sessionID) },
                                failureCopy: { _ in L.t("cardmenu_stop_failed", session.name) },
                                isCurrent: { allowsWrites })
                        }
                    }.frame(minHeight: 28).disabled(command.busy)
                    .accessibilityIdentifier("terminal-steers-stop")
                }
                TerminalSteerHoldButton { openEditor(.close) }
                    .disabled(command.busy).accessibilityIdentifier("terminal-steers-decommission")
            }
            if let message = command.message { Text(verbatim: message).font(.caption).foregroundStyle(.red) }
        }
    }

    private func openEditor(_ mode: ComposeActions.Action) {
        guard allowsWrites else { return }
        allOpen = false
        editor = mode
    }

    private func send(_ steer: ComposeSteer) {
        Task {
            await delivery.send(steer, allowed: { allowsWrites },
                reply: { try await store.client.replySession(id: sessionID, text: $0) })
        }
    }

    private func load() async {
        guard current else { return }
        await library.load(steers: { try await store.client.steers() }, repos: {
            Dictionary(try await store.client.repos().repos.map { ($0.path, $0.name) },
                uniquingKeysWith: { first, _ in first })
        })
    }
}

private struct SteerShortcut: ViewModifier {
    let number: Int?
    func body(content: Content) -> some View {
        if let number { content.keyboardShortcut(KeyEquivalent(Character(String(number))), modifiers: .command) }
        else { content }
    }
}

/// Holding opens the existing archive confirmation sheet; it never archives directly.
private struct TerminalSteerHoldButton: View {
    let confirm: () -> Void
    @State private var progress: CGFloat = 0
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Text(L.t("native_ios_steers_end_hold"))
            .foregroundStyle(ShepherdPalette.red)
            .padding(.horizontal, 10).frame(minHeight: 32)
            .background(alignment: .leading) {
                GeometryReader { geometry in
                    ShepherdPalette.red.opacity(0.18).frame(width: geometry.size.width * progress)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(ShepherdPalette.red.opacity(0.6)) }
            .contentShape(RoundedRectangle(cornerRadius: 6))
            .onLongPressGesture(minimumDuration: 1.2, maximumDistance: 40) {
                guard isEnabled else { return }
                progress = 0
                confirm()
            } onPressingChanged: { pressing in
                withAnimation(pressing ? .linear(duration: 1.2) : .easeOut(duration: 0.15)) {
                    progress = pressing && isEnabled ? 1 : 0
                }
            }
            .accessibilityElement(children: .ignore).accessibilityLabel(L.t("native_ios_steers_end_hold"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if isEnabled { confirm() } }
    }
}
