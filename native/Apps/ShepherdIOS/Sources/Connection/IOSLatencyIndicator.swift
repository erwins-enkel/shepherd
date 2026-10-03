import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Fixed catalog keys and locale-aware formatting, independent of the views.
enum IOSLatencyCopy {
    static func keys(for verdict: LatencyReport.Verdict) -> (title: StaticString, explanation: StaticString) {
        switch verdict {
        case .measuring: ("native_ios_latency_measuring", "native_ios_latency_measuring_explanation")
        case .ok: ("native_ios_latency_ok", "native_ios_latency_ok_explanation")
        case .networkSlow: ("native_ios_latency_network_slow", "native_ios_latency_network_slow_explanation")
        case .serverSlow: ("native_ios_latency_server_slow", "native_ios_latency_server_slow_explanation")
        case .serverStalled: ("native_ios_latency_server_stalled", "native_ios_latency_server_stalled_explanation")
        case .terminalSlow: ("native_ios_latency_terminal_slow", "native_ios_latency_terminal_slow_explanation")
        case .appSlow: ("native_ios_latency_app_slow", "native_ios_latency_app_slow_explanation")
        case .slowUnknown: ("native_ios_latency_slow_unknown", "native_ios_latency_slow_unknown_explanation")
        }
    }

    static func shortLabel(_ verdict: LatencyReport.Verdict) -> String { L.t(keys(for: verdict).title) }
    static func title(_ verdict: LatencyReport.Verdict) -> String { L.t(keys(for: verdict).title) }
    static func explanation(_ verdict: LatencyReport.Verdict) -> String { L.t(keys(for: verdict).explanation) }

    static func milliseconds(_ value: Double?, locale: Locale = .current) -> String {
        guard let value else { return "—" }
        if value >= 1000 { return String(format: "%.1f s", locale: locale, value / 1000) }
        return String(format: "%d ms", locale: locale, Int(value.rounded()))
    }
}

struct IOSLatencyIndicator: View {
    let monitor: IOSLatencyMonitor
    var compact = false
    @State private var showsSheet = false

    var body: some View {
        Button { showsSheet = true } label: {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(verbatim: label).foregroundStyle(color)
            }
            .font(.system(.caption, design: .monospaced))
            .frame(minWidth: 44, minHeight: compact ? 14 : 44)

            .contentShape(Rectangle().inset(by: compact ? -15 : 0))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L.t("native_ios_latency_title") + ": " + IOSLatencyCopy.title(monitor.report.verdict))
        .accessibilityIdentifier("latency-indicator")
        .sheet(isPresented: $showsSheet) { IOSLatencySheet(monitor: monitor) }
    }

    private var label: String {
        if monitor.report.verdict == .ok {
            let value = monitor.report.networkMedianMs ?? monitor.report.totalMedianMs
            return String(format: "%d ms", Int((value ?? 0).rounded()))
        }
        return IOSLatencyCopy.shortLabel(monitor.report.verdict)
    }

    private var color: Color {
        switch monitor.report.verdict {
        case .measuring: IOSTerminalStyle.muted
        case .ok: Color(red: 90 / 255, green: 209 / 255, blue: 154 / 255)
        case .serverSlow, .serverStalled: Color(red: 229 / 255, green: 72 / 255, blue: 77 / 255)
        default: IOSTerminalStyle.amber
        }
    }
}

struct IOSLatencySheet: View {
    let monitor: IOSLatencyMonitor
    @Environment(\.dismiss) private var dismiss
    private var report: LatencyReport { monitor.report }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: IOSLatencyCopy.title(report.verdict)).font(.headline)
                        Text(verbatim: IOSLatencyCopy.explanation(report.verdict))
                            .foregroundStyle(IOSTerminalStyle.muted)
                    }.listRowBackground(IOSTerminalStyle.panel)
                }
                Section(L.t("native_ios_latency_requests")) {
                    timing("native_ios_latency_median", report.totalMedianMs)
                    timing("native_ios_latency_p90", report.totalP90Ms)
                    timing("native_ios_latency_maximum", report.totalMaxMs)
                    row("native_ios_latency_sample_count", report.sampleCount.formatted())
                }
                Section(L.t("native_ios_latency_network")) {
                    timing("native_ios_latency_round_trip", report.networkMedianMs ?? report.totalMedianMs)
                    if report.networkMedianMs == nil { note("native_ios_latency_network_fallback") }
                }
                Section(L.t("native_ios_latency_server")) {
                    if report.serverReportsTiming {
                        timing("native_ios_latency_handler_median", report.serverMedianMs)
                        timing("native_ios_latency_handler_p90", report.serverP90Ms)
                        timing("native_ios_latency_stall", report.lagMaxMs)
                    } else { note("native_ios_latency_no_server_timing") }
                }
                if let terminal = report.terminal {
                    Section(L.t("native_ios_latency_terminal")) {
                        timing("native_ios_latency_connected", terminal.connectedMs)
                        timing("native_ios_latency_first_output", terminal.firstOutputMs)
                        row("native_ios_latency_replay_size",
                            String(format: "%.1f KB", locale: Locale.current, Double(terminal.replayBytes) / 1024))
                        timing("native_ios_latency_render_time", terminal.renderMs)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(IOSTerminalStyle.background)
            .foregroundStyle(IOSTerminalStyle.ink)
            .navigationTitle(L.t("native_ios_latency_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await monitor.measure() } } label: {
                        if monitor.probing { ProgressView() }
                        else { Text(verbatim: L.t("native_ios_latency_measure_again")) }
                    }
                    .disabled(monitor.probing)
                    .accessibilityLabel(L.t("native_ios_latency_measure_again"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L.t("native_ios_latency_done")) { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(IOSTerminalStyle.amber)
        .accessibilityIdentifier("latency-sheet")
    }

    private func timing(_ key: StaticString, _ value: Double?) -> some View {
        row(key, IOSLatencyCopy.milliseconds(value))
    }

    private func row(_ key: StaticString, _ value: String) -> some View {
        HStack {
            Text(verbatim: L.t(key))
            Spacer()
            Text(verbatim: value).monospacedDigit().foregroundStyle(IOSTerminalStyle.muted)
        }.listRowBackground(IOSTerminalStyle.panel)
    }

    private func note(_ key: StaticString) -> some View {
        Text(verbatim: L.t(key)).foregroundStyle(IOSTerminalStyle.muted)
            .listRowBackground(IOSTerminalStyle.panel)
    }
}
