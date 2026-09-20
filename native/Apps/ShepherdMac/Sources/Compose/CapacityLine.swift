import ShepherdKit
import SwiftUI

/// Display projection only: the generated contract remains the sole payload type source.
/// Task 9 uses CapacityLine(provider:); SessionSignals.usageLimits supplies S3's reconciled
/// REST/push state. Do not retain a bootstrap snapshot or build a separate push cache.
enum ComposeCapacity {
    enum Tone { case muted, amber, red }

    struct Window: Equatable {
        let key: String
        let usedPct: Double
        let resetAt: Int
        var remainingPct: Double { 100 - usedPct }

        init(key: String, pct: Double, resetAt: Int) {
            self.key = key
            usedPct = min(max(pct, 0), 100)
            self.resetAt = resetAt
        }

        // Documented exception to the four-light rule: capacity follows the web's
        // usage thresholds, with red > 90%, amber > 50%, and muted otherwise.
        var tone: Tone { usedPct > 90 ? .red : usedPct > 50 ? .amber : .muted }

        var tint: Color {
            switch tone {
            case .muted: .secondary
            case .amber: .orange
            case .red: .red
            }
        }

        var freeCopy: String { L.t("newtask_provider_capacity_free", remainingPct.formatted(.number)) }

        func copy(now: Date = Date()) -> String {
            let pct = remainingPct.formatted(.number)
            let reset = Date(timeIntervalSince1970: Double(resetAt) / 1000)
            if reset > now {
                return L.t("newtask_provider_capacity_free_until", pct,
                           reset.formatted(date: .abbreviated, time: .shortened))
            }
            return L.t("newtask_provider_capacity_free", pct)
        }
    }

    struct Row {
        let provider: AgentProvider
        let windows: [Window]
        let stale: Bool
        var opacity: Double { stale ? 0.55 : 1 }
    }

    struct Selected {
        let provider: AgentProvider
        let window: Window
        let stale: Bool
        var code: String { ComposeCapacity.code(provider, key: window.key) }
        var opacity: Double { stale ? 0.55 : 1 }
    }

    static func code(_ provider: AgentProvider, key: String) -> String {
        "\(provider == .claude ? "CC" : "CX")·\(key)"
    }

    static func rows(_ limits: UsageLimits?) -> [Row] {
        let claude = limits?.providers?.compactMap { snapshot -> Components.Schemas.ClaudeUsageProviderSnapshot? in
            guard case .ClaudeUsageProviderSnapshot(let value) = snapshot,
                  value.provider.rawValue == "claude", value.kind.rawValue == "limits" else { return nil }
            return value
        }.first
        let codex = limits?.providers?.compactMap { snapshot -> Components.Schemas.CodexUsageProviderSnapshot? in
            guard case .CodexUsageProviderSnapshot(let value) = snapshot,
                  value.provider.rawValue == "codex", value.kind.rawValue == "tokens" else { return nil }
            return value
        }.first

        // An observed object is authoritative as a whole, even when empty or partial.
        // Do not fill missing observed windows with local estimates.
        let observed = limits?.observed ?? claude?.observed
        let claudeWindows: [Window]
        if let observed {
            claudeWindows = [
                observed.session5h.map { Window(key: "5H", pct: $0.pct, resetAt: $0.resetAt) },
                observed.week.map { Window(key: "WK", pct: $0.pct, resetAt: $0.resetAt) }
            ].compactMap { $0 }
        } else {
            claudeWindows = windows(session5h: limits?.session5h, week: limits?.week)
        }
        return [
            Row(provider: .claude, windows: claudeWindows, stale: limits?.stale ?? false),
            Row(provider: .codex, windows: windows(session5h: codex?.session5h, week: codex?.week),
                stale: codex?.stale ?? false)
        ]
    }

    private static func windows(session5h: Components.Schemas.LimitWindow?,
                                week: Components.Schemas.LimitWindow?) -> [Window] {
        [session5h.map { Window(key: "5H", pct: $0.pct, resetAt: $0.resetAt) },
         week.map { Window(key: "WK", pct: $0.pct, resetAt: $0.resetAt) }].compactMap { $0 }
    }

    static func selected(_ limits: UsageLimits?, provider: AgentProvider) -> Selected? {
        guard let row = rows(limits).first(where: { $0.provider == provider }),
              let first = row.windows.first else { return nil }
        let hottest = row.windows.dropFirst().reduce(first) {
            $1.remainingPct < $0.remainingPct ? $1 : $0
        }
        return Selected(provider: provider, window: hottest, stale: row.stale)
    }
}

struct CapacityLine: View {
    let provider: AgentProvider
    private let usageLimits: @MainActor () -> UsageLimits?
    @State private var allPresented = false

    init(provider: AgentProvider,
         usageLimits: @escaping @MainActor () -> UsageLimits? = { SessionSignals.usageLimits() }) {
        self.provider = provider
        self.usageLimits = usageLimits
    }

    /// The rendering values consumed by both the compact line and its all-windows popover.
    /// Read inside SwiftUI's observation scope so reconciliation and pushes invalidate the view.
    var state: (selected: ComposeCapacity.Selected?, rows: [ComposeCapacity.Row]) {
        let limits = usageLimits()
        return (ComposeCapacity.selected(limits, provider: provider), ComposeCapacity.rows(limits))
    }

    var body: some View {
        if let capacity = state.selected {
            HStack(spacing: 8) {
                meter(provider: provider, window: capacity.window, showReset: false)
                Button(L.t("newtask_capacity_all"), systemImage: "chevron.down") {
                    allPresented.toggle()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L.t("newtask_capacity_all_aria"))
                .accessibilityIdentifier("compose.capacity.all")
                .popover(isPresented: $allPresented) { allWindows }
            }
            .font(.caption)
            .monospacedDigit()
            .opacity(capacity.opacity)
            .accessibilityIdentifier("compose.capacity")
        }
    }

    private var allWindows: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: L.t("newtask_provider_capacity_title")).font(.headline)
            ForEach(state.rows, id: \.provider) { row in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: EnginePicker.name(row.provider)).fontWeight(.medium)
                    if row.windows.isEmpty {
                        Text(verbatim: L.t("newtask_provider_capacity_unavailable"))
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(row.windows, id: \.key) { window in
                            meter(provider: row.provider, window: window, showReset: true)
                        }
                    }
                }
                .opacity(row.opacity)
            }
        }
        .font(.caption)
        .monospacedDigit()
        .padding()
        .accessibilityLabel(L.t("newtask_capacity_all_aria"))
        .accessibilityIdentifier("compose.capacity.windows")
        .onExitCommand { allPresented = false }
    }

    private func meter(provider: AgentProvider, window: ComposeCapacity.Window, showReset: Bool) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: ComposeCapacity.code(provider, key: window.key))
                .font(.system(.caption, design: .monospaced))
            ProgressView(value: window.remainingPct, total: 100)
                .tint(window.tint)
                .frame(width: 64)
                .accessibilityLabel(L.t("newtask_provider_capacity_meter_window_aria",
                                       EnginePicker.name(provider), window.key, window.remainingPct.formatted(.number)))
            Text(verbatim: showReset ? window.copy() : window.freeCopy)
        }
        .foregroundStyle(.secondary)
    }

}
