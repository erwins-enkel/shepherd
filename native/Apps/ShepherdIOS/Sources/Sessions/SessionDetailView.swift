import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionDetailView: View {
    let session: Session
    let model: DetailModel
    @State private var terminal: IOSTerminalPresentation
    @AppStorage private var fontSize: Double
    @Environment(AppModel.self) private var app

    init(session: Session, model: DetailModel, terminal: TerminalSessionModel, defaults: UserDefaults) {
        self.session = session
        self.model = model
        _terminal = State(initialValue: IOSTerminalPresentation(session: terminal))
        _fontSize = AppStorage(wrappedValue: 12, "ios.terminal.fontSize", store: defaults)
    }

    var body: some View {
        IOSSessionDetailContent(session: session, model: model, terminal: terminal,
            allowsInput: app.allowsTerminalInput, fontSize: $fontSize,
            surface: IOSTerminalHostView(model: terminal, fontSize: fontSize))
    }
}

enum IOSSessionDetailTab: CaseIterable {
    case terminal, activity, info
    var title: String {
        switch self {
        case .terminal: L.t("native_terminal_tab_title")
        case .activity: L.t("native_detail_tab_activity")
        case .info: L.t("native_ios_detail_info")
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

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(verbatim: session.desig).foregroundStyle(IOSTerminalStyle.muted)
                Spacer(minLength: 4)
                Label(SessionStatusStyle.label(session.status), systemImage: statusSymbol)
                    .foregroundStyle(statusColor)
            }
            .font(.system(.caption, design: .monospaced))
            .padding(.horizontal, 12).padding(.vertical, 8)
            HStack(spacing: 0) {
                ForEach(IOSSessionDetailTab.allCases, id: \.self) { item in
                    Button { tab = item } label: {
                        Text(verbatim: item.title.uppercased())
                            .font(.system(.caption, design: .monospaced).weight(.semibold))
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
            switch tab {
            case .terminal:
                IOSTerminalPane(model: terminal, allowsInput: allowsInput, surface: surface, fontSize: $fontSize)
            case .activity:
                List { ActivityView(session: session, model: model).listRowBackground(IOSTerminalStyle.panel) }
                    .listStyle(.plain).scrollContentBackground(.hidden)
                    .font(.system(.body, design: .monospaced))
            case .info:
                info
            }
        }
        .foregroundStyle(IOSTerminalStyle.ink)
        .background(IOSTerminalStyle.background)
        .tint(IOSTerminalStyle.amber)
        .preferredColorScheme(.dark)
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("session-detail")
    }

    private var info: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                infoField(L.t("native_detail_status_label"), SessionStatusStyle.label(session.status))
                infoField(L.t("native_ios_detail_task"), session.desig)
                infoField(L.t("native_ios_detail_path"), session.repoPath)
                if let branch = session.branch { infoField(L.t("native_ios_detail_branch"), branch) }
                infoField(L.t("newtask_prompt_label"), session.prompt)
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }.accessibilityIdentifier("detail-tab-info")
    }

    private func infoField(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: label.uppercased()).font(.system(.caption, design: .monospaced))
                .foregroundStyle(IOSTerminalStyle.muted)
            Text(verbatim: value).font(.system(.body, design: .monospaced)).textSelection(.enabled)
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
