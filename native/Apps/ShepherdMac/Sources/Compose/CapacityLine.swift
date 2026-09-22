import ShepherdAppCore
import ShepherdKit
import SwiftUI

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
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("compose.capacity")
        } else {
            Text(L.t("newtask_provider_capacity_unavailable"))
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("compose.capacity")
        }
    }

    // Internal so tests inspect the same popover content SwiftUI presents.
    var allWindows: some View {
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
