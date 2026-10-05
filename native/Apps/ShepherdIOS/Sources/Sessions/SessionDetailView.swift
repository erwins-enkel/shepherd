import SwiftUI
import UIKit
import ShepherdAppCore
import ShepherdKit

struct SessionDetailView: View {
    let session: Session
    let model: DetailModel
    let terminal: IOSTerminalPresentation
    @AppStorage private var fontSize: Double
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var latency: IOSLatencyMonitor?
    @State private var steers = IOSSteerLibrary()
    @State private var gesture = IOSSteerGestureState()

    init(session: Session, model: DetailModel, terminal: IOSTerminalPresentation, defaults: UserDefaults) {
        self.session = session
        self.model = model
        self.terminal = terminal
        _fontSize = AppStorage(wrappedValue: 12, "ios.terminal.fontSize", store: defaults)
    }

    var body: some View {
        ZStack {
            swipeReveal
            detailContent
                .offset(x: gesture.swipe.offset)
            if gesture.steersOpen { steerPanel }
        }
        .onAppear { configureGesture() }
        .onChange(of: sizeClass) { _, _ in configureGesture() }
        .task(id: session.id) {
            guard let client = app.store?.client else { latency = nil; return }
            let monitor = IOSLatencyMonitor.make(client: client, terminal: terminal, sessionID: session.id)
            latency = monitor
            await monitor.run()
        }
        .task(id: app.activationGeneration) {
            guard let client = app.store?.client, app.allowsTerminalInput else { return }
            await steers.load(steers: { try await client.steers() }, repos: {
                Dictionary(try await client.repos().repos.map { ($0.path, $0.name) }, uniquingKeysWith: { first, _ in first })
            })
        }
    }

    private var detailContent: some View {
        IOSSessionDetailContent(session: session, model: model, terminal: terminal,
            allowsInput: app.allowsTerminalInput, fontSize: $fontSize,
            surface: terminalSurface,
            planSurface: planSurface,
            planEntryLabel: planEntryLabel,
            planInitialEntry: planInitialEntry,
            planOpenTick: app.extension(PlanModel.self)?.openPlanTick[session.id] ?? 0,
            latency: latency,
            steerChips: steerChips,
            repoName: steers.repoNames[session.repoPath] ?? IOSSessionDetailContent<EmptyView>.repoFallback(session.repoPath),
            focused: gesture.focused,
            toggleFocus: { gesture.toggleFocus() },
            back: { [app] in app.selectedSessionID = nil },
            actionMenu: AnyView(IOSSessionChromeActions(session: session, placement: .menu)),
            inlineActions: AnyView(IOSSessionChromeActions(session: session, placement: .inline)),
            recap: AnyView(IOSSessionChromeActions(session: session, placement: .recap)))
    }

    private var terminalSurface: IOSTerminalHostView {
        let gesture = gesture
        guard !gesture.steersOpen else { return IOSTerminalHostView(model: terminal, fontSize: fontSize) }
        return IOSTerminalHostView(model: terminal, fontSize: fontSize,
            onHorizontalPan: { @MainActor pan in gesture.handle(pan) },
            onDoubleTap: { @MainActor in gesture.toggleFocus() })
    }

    private var planInitialEntry: Bool {
        let controller = app.extension(IOSPlanController.self)
        return controller?.entrySessionID == session.id && controller?.entryOpensPlan == true
    }

    private var steerChips: AnyView? {
        guard app.allowsTerminalInput, !gesture.focused else { return nil }
        let chips = IOSSteerChips(steers: steers.barSteers(for: session), terminal: terminal,
            openAll: { gesture.setSteersOpen(true) })
        return AnyView(chips)
    }

    // MARK: - Swipe: right to the overview, left to the steers

    /// Right goes back only where there is a list to go back to (compact width).
    private func configureGesture() {
        gesture.allowsBack = sizeClass != .regular
        gesture.allowsSteers = app.allowsTerminalInput
        gesture.back = { [app] in app.selectedSessionID = nil }
    }

    @ViewBuilder private var swipeReveal: some View {
        if gesture.swipe.offset != 0 {
            let left = gesture.swipe.offset < 0
            HStack {
                if left { Spacer() }
                VStack(spacing: 8) {
                    Image(systemName: left ? "slider.horizontal.3" : "list.bullet")
                        .font(.title2)
                        .frame(width: 52, height: 52)
                        .background(gesture.swipe.armed ? ComposePalette.amber : ComposePalette.panel2, in: Circle())
                        .foregroundStyle(gesture.swipe.armed ? ComposePalette.bg : ComposePalette.ink)
                    Text(L.t(left ? "native_ios_steers_title" : "native_ios_steers_overview"))
                        .font(.system(.callout).weight(.semibold))
                        .foregroundStyle(gesture.swipe.armed ? ComposePalette.amber : ComposePalette.ink)
                    if gesture.swipe.armed {
                        Text(L.t(left ? "native_ios_steers_release_open" : "native_ios_steers_release_back"))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(ComposePalette.muted)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(width: max(96, abs(gesture.swipe.offset)))
                if !left { Spacer() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ComposePalette.panel)
            .accessibilityHidden(true)
        }
    }

    private var steerPanel: some View {
        ZStack(alignment: .trailing) {
            Color.black.opacity(0.45).ignoresSafeArea()
                .onTapGesture { gesture.setSteersOpen(false) }
                .accessibilityHidden(true)
                .transition(.opacity)
            IOSSteerPanel(session: session, steers: steers.barSteers(for: session), loadError: steers.loadError,
                terminal: terminal, decommission: decommission, close: { gesture.setSteersOpen(false) })
                .containerRelativeFrame(.horizontal) { width, _ in min(width * 0.86, 420) }
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                    if value.translation.width > 80, abs(value.translation.width) > abs(value.translation.height) {
                        gesture.setSteersOpen(false)
                    }
                })
                .transition(.move(edge: .trailing))
        }
    }

    /// The same decommission sheet the header menu opens; the header owns its presentation.
    private var decommission: (() -> Void)? {
        guard let state = app.extension(IOSSessionActions.self)?.state(for: session), state.canDecommission else { return nil }
        return {
            gesture.setSteersOpen(false)
            state.presentDecommission()
        }
    }

    private var planSurface: AnyView? {
        guard let plan = app.extension(PlanModel.self), let store = app.store,
              session.planPhase != nil || plan.gates[session.id] != nil else { return nil }
        return AnyView(IOSPlanView(session: session, model: plan, store: store, app: app))
    }
    private var planEntryLabel: String? {
        guard let plan = app.extension(PlanModel.self) else { return nil }
        if session.planPhase?.known == .planning, plan.questionsUnanswered(session.id) { return L.t("hold_cta_answer") }
        return PlanGateChip.chip(session: session, gate: plan.gates[session.id],
            reviewing: plan.reviewing.contains(session.id)).iosLabel
    }
}

enum IOSSessionDetailTab: CaseIterable {
    case terminal, activity, info, plan
    var title: String {
        switch self {
        case .terminal: L.t("native_terminal_tab_title")
        case .activity: L.t("native_detail_tab_activity")
        case .info: L.t("native_ios_detail_info")
        case .plan: L.t("plangate_view")
        }
    }
}

struct IOSSessionDetailContent<Surface: View>: View {
    let session: Session
    let model: DetailModel
    let terminal: IOSTerminalPresentation
    let allowsInput: Bool
    @Binding var fontSize: Double
    let surface: Surface
    @State var tab: IOSSessionDetailTab = .terminal
    // ImageRenderer cannot draw UIKit-backed selectable Text. Fixtures disable selection.
    var selectableText = true
    var planSurface: AnyView? = nil
    var planEntryLabel: String? = nil
    var planInitialEntry = false
    var planOpenTick = 0
    var latency: IOSLatencyMonitor? = nil
    var steerChips: AnyView? = nil
    /// The repo the session works in, shown before its designation so the screen says where it is.
    var repoName: String? = nil
    /// Focus mode: one slim line of chrome, the rest is terminal (double tap or the expand button).
    var focused = false
    var toggleFocus: (() -> Void)? = nil
    var back: (() -> Void)? = nil
    var actionMenu: AnyView? = nil
    var inlineActions: AnyView? = nil
    var recap: AnyView? = nil
    var fixtureClipboard = false
    var fixtureThumbnails: [UUID: UIImage] = [:]
    @State private var fontSettings = false
    @State private var planNavigation = IOSPlanNavigation()
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 0) {
            if focused { focusBar } else { header; tabRow }
            if tab != .terminal, let inlineActions { inlineActions }
            switch tab {
            case .terminal:
                IOSTerminalPane(model: terminal, allowsInput: allowsInput, surface: surface, fontSize: $fontSize,
                    rendersStaticFixture: !selectableText, steerChips: steerChips,
                    inlineActions: inlineActions, fixtureClipboard: fixtureClipboard, fixtureThumbnails: fixtureThumbnails)
            case .activity:
                List { ActivityView(session: session, model: model).listRowBackground(IOSTerminalStyle.panel) }
                    .listStyle(.plain).scrollContentBackground(.hidden)
                    .font(.system(.body, design: .monospaced))
            case .info:
                info
            case .plan:
                planSurface
            }
        }
        .foregroundStyle(IOSTerminalStyle.ink)
        .background(IOSTerminalStyle.background)
        .tint(IOSTerminalStyle.amber)
        .preferredColorScheme(.dark)
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("session-detail")
        .onAppear {
            if planNavigation.enter(opensPlan: planInitialEntry, tick: planOpenTick), planSurface != nil { tab = .plan }
        }
        .onChange(of: planOpenTick) { _, tick in
            if planNavigation.consume(tick: tick), planSurface != nil { tab = .plan }
        }
    }

    static func repoFallback(_ path: String) -> String? {
        let name = URL(fileURLWithPath: path).lastPathComponent
        return name.isEmpty || name == "/" ? nil : name
    }

    /// Two compact rows carry title/context and tabs. Task identity lives in Info.
    private var header: some View {
        HStack(spacing: 4) {
            if let back {
                Button(action: back) { Image(systemName: "chevron.backward").frame(width: 44, height: 44) }
                    .buttonStyle(.plain).foregroundStyle(IOSTerminalStyle.amber)
                    .accessibilityLabel(L.t("native_ios_steers_overview"))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: session.name).font(.system(.subheadline).weight(.semibold))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 7, height: 7).accessibilityHidden(true)
                    Text(verbatim: SessionStatusStyle.label(session.status).lowercased()).foregroundStyle(statusColor)
                    if let repoName {
                        Text(verbatim: "·").accessibilityHidden(true)
                        Text(verbatim: repoName).lineLimit(1).accessibilityIdentifier("detail-repo")
                    }
                    if let latency {
                        Text(verbatim: "·").accessibilityHidden(true)
                        IOSLatencyIndicator(monitor: latency, compact: true)
                    }
                }.font(.system(.caption2)).foregroundStyle(IOSTerminalStyle.muted)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let actionMenu { actionMenu }
            else { Image(systemName: "ellipsis").frame(width: 44, height: 44).accessibilityHidden(true) }
        }
        .padding(.horizontal, 4).frame(minHeight: 52)
    }

    /// Tabs and the terminal's own controls share one row instead of two.
    @ViewBuilder private var tabRow: some View {
        HStack(spacing: 0) {
            Group {
                if dynamicTypeSize.isAccessibilitySize, selectableText {
                    ScrollView(.horizontal) { tabs.fixedSize(horizontal: true, vertical: false) }.scrollIndicators(.hidden)
                } else if dynamicTypeSize.isAccessibilitySize {
                    GeometryReader { geometry in
                        tabs.fixedSize(horizontal: true, vertical: false)
                            .frame(width: geometry.size.width, alignment: .leading).clipped()
                    }.frame(height: 60)
                } else { tabs }
            }
            if tab == .terminal { terminalControls }
        }
        .background(IOSTerminalStyle.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(IOSTerminalStyle.line).frame(height: 1) }
    }

    @ViewBuilder private var terminalControls: some View {
        if let toggleFocus {
            Button(action: toggleFocus) {
                Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: dynamicTypeSize.isAccessibilitySize ? 44 : 38)
                    .contentShape(Rectangle().inset(by: dynamicTypeSize.isAccessibilitySize ? 0 : -3))
            }
            .buttonStyle(.plain).foregroundStyle(IOSTerminalStyle.muted)
            .accessibilityLabel(L.t("native_ios_terminal_focus"))
            .accessibilityIdentifier("terminal-focus")
        }
        Button { fontSettings = true } label: {
            Image(systemName: "textformat.size").frame(width: 44, height: dynamicTypeSize.isAccessibilitySize ? 44 : 38)
                    .contentShape(Rectangle().inset(by: dynamicTypeSize.isAccessibilitySize ? 0 : -3))
        }
        .buttonStyle(.plain).foregroundStyle(IOSTerminalStyle.muted)
        .accessibilityLabel(L.t("native_ios_terminal_font_size"))
        .accessibilityIdentifier("terminal-font-settings")
        .popover(isPresented: $fontSettings) {
            IOSTerminalFontSettings(fontSize: $fontSize)
                .presentationCompactAdaptation(.popover)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(IOSTerminalStyle.line).frame(height: 1) }
    }

    /// Focus mode's only chrome: back, where, state. Tapping the line leaves focus mode.
    private var focusBar: some View {
        HStack(spacing: 4) {
            if let back {
                Button(action: back) { Image(systemName: "chevron.backward").frame(width: 44, height: 44) }
                    .buttonStyle(.plain).foregroundStyle(IOSTerminalStyle.ink)
                    .accessibilityLabel(L.t("native_ios_steers_overview"))
            }
            Button { toggleFocus?() } label: {
                HStack(spacing: 6) {
                    if let repoName {
                        Text(verbatim: repoName).foregroundStyle(IOSTerminalStyle.muted)
                        Text(verbatim: "›").foregroundStyle(IOSTerminalStyle.muted)
                    }
                    Text(verbatim: session.name).foregroundStyle(IOSTerminalStyle.ink)
                    Spacer(minLength: 4)
                    Image(systemName: statusSymbol).foregroundStyle(statusColor).font(.caption2)
                    Text(verbatim: SessionStatusStyle.label(session.status).uppercased()).foregroundStyle(statusColor)
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(L.t("native_ios_terminal_focus_exit"))
            .accessibilityIdentifier("terminal-focus-bar")
            if let actionMenu { actionMenu }
        }
        .font(.system(.caption, design: .monospaced))
        .padding(.trailing, 12)
        .background(IOSTerminalStyle.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(IOSTerminalStyle.line).frame(height: 1) }
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(IOSSessionDetailTab.allCases.filter { $0 != .plan || planSurface != nil }, id: \.self) { item in
                Button { tab = item } label: {
                    Text(verbatim: item.title.uppercased())
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 44 : 38)
                        .contentShape(Rectangle().inset(by: dynamicTypeSize.isAccessibilitySize ? 0 : -3))
                        .foregroundStyle(tab == item ? IOSTerminalStyle.amber : IOSTerminalStyle.muted)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(tab == item ? IOSTerminalStyle.amber : IOSTerminalStyle.line)
                                .frame(height: 1)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(tab == item ? .isSelected : [])
                .accessibilityIdentifier("detail-select-\(item)")
            }
        }.background(IOSTerminalStyle.panel)
    }

    @ViewBuilder private var info: some View {
        if selectableText {
            ScrollView { infoFields }
                .accessibilityIdentifier("detail-tab-info")
        } else {
            // ScrollView is UIKit-backed too; render the same first viewport statically.
            GeometryReader { geometry in
                infoFields.fixedSize(horizontal: false, vertical: true)
                    .frame(width: geometry.size.width, alignment: .topLeading)
            }.clipped()
        }
    }

    private var infoFields: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let recap { recap }
            infoField(L.t("native_detail_status_label"), SessionStatusStyle.label(session.status))
            infoField(L.t("native_ios_detail_task"), session.desig)
            infoField(L.t("native_ios_detail_path"), session.repoPath)
            if let branch = session.branch { infoField(L.t("native_ios_detail_branch"), branch) }
            infoField(L.t("newtask_prompt_label"), session.prompt)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func infoField(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: label.uppercased()).font(.system(.caption, design: .monospaced))
                .foregroundStyle(IOSTerminalStyle.muted)
            if selectableText {
                Text(verbatim: value).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            } else { Text(verbatim: value).font(.system(.body, design: .monospaced)) }
        }
    }

    private var statusSymbol: String {
        switch session.status.known {
        case .running: "circle.fill"
        case .blocked: "exclamationmark.circle.fill"
        case .done: session.readyToMerge ? "checkmark.circle" : "pause.circle"
        case .idle, .archived, nil: "circle"
        }
    }
    private var statusColor: Color {
        switch session.status.known {
        case .running: IOSTerminalStyle.amber
        case .blocked: SessionListStyle.red
        case .done where session.readyToMerge: SessionListStyle.green
        default: IOSTerminalStyle.muted
        }
    }
}
