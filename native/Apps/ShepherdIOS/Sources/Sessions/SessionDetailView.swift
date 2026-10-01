import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionDetailView: View {
    let session: Session
    let model: DetailModel
    let terminal: IOSTerminalPresentation
    @AppStorage private var fontSize: Double
    @Environment(AppModel.self) private var app

    init(session: Session, model: DetailModel, terminal: IOSTerminalPresentation, defaults: UserDefaults) {
        self.session = session
        self.model = model
        self.terminal = terminal
        _fontSize = AppStorage(wrappedValue: 12, "ios.terminal.fontSize", store: defaults)
    }

    var body: some View {
        IOSSessionDetailContent(session: session, model: model, terminal: terminal,
            allowsInput: app.allowsTerminalInput, fontSize: $fontSize,
            surface: IOSTerminalHostView(model: terminal, fontSize: fontSize),
            planSurface: planSurface,
            planEntryLabel: planEntryLabel,
            planInitialEntry: app.extension(IOSPlanController.self)?.entrySessionID == session.id
                && app.extension(IOSPlanController.self)?.entryOpensPlan == true,
            planOpenTick: app.extension(PlanModel.self)?.openPlanTick[session.id] ?? 0)
            .safeAreaInset(edge: .bottom, spacing: 0) { IOSSessionActionBar(session: session) }
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
    @State private var planNavigation = IOSPlanNavigation()
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(verbatim: session.desig).foregroundStyle(IOSTerminalStyle.muted)
                Spacer(minLength: 4)
                if let planEntryLabel, planSurface != nil {
                    Button { tab = .plan } label: {
                        Text(verbatim: planEntryLabel).foregroundStyle(IOSTerminalStyle.amber)
                            .frame(minHeight: 44)
                    }.buttonStyle(.plain)
                        .accessibilityLabel(L.t("plangate_menu_open_plan") + ": " + planEntryLabel)
                        .accessibilityIdentifier("detail-open-plan")
                }
                Label(SessionStatusStyle.label(session.status), systemImage: statusSymbol)
                    .foregroundStyle(statusColor)
            }
            .font(.system(.caption, design: .monospaced))
            .padding(.horizontal, 12).padding(.vertical, 8)
            if dynamicTypeSize.isAccessibilitySize, selectableText {
                ScrollView(.horizontal) { tabs.fixedSize(horizontal: true, vertical: false) }.scrollIndicators(.hidden)
            } else if dynamicTypeSize.isAccessibilitySize {
                GeometryReader { geometry in
                    tabs.fixedSize(horizontal: true, vertical: false)
                        .frame(width: geometry.size.width, alignment: .leading).clipped()
                }.frame(height: 60)
            } else { tabs }
            switch tab {
            case .terminal:
                IOSTerminalPane(model: terminal, allowsInput: allowsInput, surface: surface, fontSize: $fontSize,
                    rendersStaticFixture: !selectableText)
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
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("session-detail")
        .onAppear {
            if planNavigation.enter(opensPlan: planInitialEntry, tick: planOpenTick), planSurface != nil { tab = .plan }
        }
        .onChange(of: planOpenTick) { _, tick in
            if planNavigation.consume(tick: tick), planSurface != nil { tab = .plan }
        }
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(IOSSessionDetailTab.allCases.filter { $0 != .plan || planSurface != nil }, id: \.self) { item in
                Button { tab = item } label: {
                    Text(verbatim: item.title.uppercased())
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: 44)
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
        case .blocked: Color(red: 229 / 255, green: 72 / 255, blue: 77 / 255)
        case .done where session.readyToMerge: Color(red: 90 / 255, green: 209 / 255, blue: 154 / 255)
        default: IOSTerminalStyle.muted
        }
    }
}
