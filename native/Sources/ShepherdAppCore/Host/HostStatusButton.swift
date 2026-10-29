import SwiftUI
import ShepherdKit

/// Each instance is scoped to one server store; switching servers discards its snapshot.
public struct HostStatusButton: View {
    public let store: SessionStore
    public var serverName: String?
    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshot: Components.Schemas.HeavySlotSnapshot?
    @State private var showingDetails = false
    @State private var failed = false

    public init(store: SessionStore, serverName: String? = nil) {
        self.store = store
        self.serverName = serverName
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if snapshot?.enabled == true || failed {
                Button { showingDetails = true } label: {
                    Label {
                        Text(verbatim: [serverName, L.t("heavyslot_label"), snapshot.map {
                            "\($0.holders.count)/\($0.capacity)" + ($0.waiters.isEmpty ? "" : " · \(L.t("heavyslot_queue")) \($0.waiters.count)")
                        }]
                            .compactMap { $0 }.joined(separator: " · "))
                    } icon: { Image(systemName: snapshot?.brake.active == true ? "exclamationmark.triangle" : "server.rack") }
                    #if os(iOS)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                    #endif
                }
                .tint(snapshot?.brake.active == true ? .orange : .accentColor)
                .accessibilityLabel(Text(verbatim: snapshot.map {
                    [serverName, L.t("heavyslot_chip_aria", String($0.holders.count), String($0.capacity), String($0.waiters.count))]
                        .compactMap { $0 }.joined(separator: ": ")
                } ?? L.t("heavyslot_label")))
                .accessibilityIdentifier("host-status-button")
            }
        }
        .sheet(isPresented: $showingDetails) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading) {
                        Text(verbatim: L.t("heavyslot_popover_title")).font(.headline)
                        if let serverName { Text(verbatim: serverName).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button(L.t("common_close")) { showingDetails = false }
                }
                if failed {
                    Text(verbatim: L.t("native_host_unavailable")).foregroundStyle(.secondary)
                } else if let snapshot {
                    HostStatusDetails(snapshot: snapshot, sessions: store.sessions)
                }
            }
            .padding()
            .frame(minWidth: 280, idealWidth: 440, maxWidth: 560)
            #if os(macOS)
            .frame(minHeight: 320, idealHeight: 520)
            #endif
            .presentationDetents([.medium, .large])
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do {
                    let value = try await store.client.heavySlot()
                    try Task.checkCancellation()
                    snapshot = value
                    failed = false
                } catch {
                    guard !Task.isCancelled else { return }
                    snapshot = nil
                    failed = true
                }
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
    }
}

private struct HostStatusDetails: View {
    let snapshot: Components.Schemas.HeavySlotSnapshot
    let sessions: [Session]

    private func name(_ id: String) -> String {
        sessions.first { $0.id == id }?.name ?? L.t("heavyslot_unknown_session")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                section("heavyslot_holders") {
                    if snapshot.holders.isEmpty { Text(verbatim: L.t("heavyslot_none_holding")) }
                    ForEach(snapshot.holders.indices, id: \.self) { i in
                        let holder = snapshot.holders[i]
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: name(holder.sessionId)).fontWeight(.medium)
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                let seconds = max(0, Int(context.date.timeIntervalSince1970) - holder.startedAt / 1000)
                                Text(verbatim: "\(seconds / 60):\(String(format: "%02d", seconds % 60)) · \(HostStatusFormat.bytes(holder.rssBytes))")
                                    .foregroundStyle(.secondary).monospacedDigit()
                            }
                            DisclosureGroup(L.t("heavyslot_command_expand")) {
                                Text(verbatim: holder.command).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    }
                }
                section("heavyslot_queue") {
                    if snapshot.waiters.isEmpty { Text(verbatim: L.t("heavyslot_queue_empty")) }
                    ForEach(snapshot.waiters.sorted { $0.position < $1.position }, id: \.sessionId) { waiter in
                        Text(verbatim: name(waiter.sessionId))
                        Text(verbatim: L.t(waiter.reason == .pressure ? "heavyslot_strip_wait_pressure" : "heavyslot_strip_wait", String(waiter.position)))
                            .foregroundStyle(.secondary)
                    }
                    if snapshot.brake.active {
                        Text(verbatim: L.t("heavyslot_strip_brake")).foregroundStyle(.orange)
                    }
                }
                section("heavyslot_pressure") {
                    let p = snapshot.pressure
                    row("heavyslot_ram_row", "\(HostStatusFormat.ramUsed(available: p.ramAvailableBytes, total: p.ramTotalBytes)) · \(HostStatusFormat.bytes(p.ramAvailableBytes)) / \(HostStatusFormat.bytes(p.ramTotalBytes))")
                    row("heavyslot_swap_row", "\(HostStatusFormat.bytes(p.swapUsedBytes)) / \(HostStatusFormat.bytes(p.swapTotalBytes))")
                    row("heavyslot_mem_psi", HostStatusFormat.percent(p.memFullAvg10))
                    if let threshold = p.memBrakeThreshold {
                        Text(verbatim: L.t("heavyslot_mem_psi_limit", threshold.formatted())).font(.caption).foregroundStyle(.secondary)
                    }
                    row("heavyslot_cpu_psi", HostStatusFormat.percent(p.cpuSomeAvg10))
                }
                section("heavyslot_source") {
                    row("heavyslot_source_agents", HostStatusFormat.bytes(snapshot.memoryBySource.agentsBytes))
                    row("heavyslot_source_foreign", HostStatusFormat.bytes(snapshot.memoryBySource.foreignBytes))
                    ForEach(snapshot.memoryBySource.foreignTop.indices, id: \.self) { i in
                        let process = snapshot.memoryBySource.foreignTop[i]
                        LabeledContent { Text(verbatim: HostStatusFormat.bytes(process.bytes)) } label: { Text(verbatim: process.name) }
                    }
                }
                if !snapshot.lastResults.isEmpty {
                    section("heavyslot_last_results") {
                        ForEach(snapshot.lastResults, id: \.sessionId) { result in
                            Text(verbatim: name(result.sessionId)).fontWeight(.medium)
                            Text(verbatim: result.stale ? L.t("heavyslot_result_stale") : resultLabel(result.result))
                            if result.stale { Text(verbatim: L.t("heavyslot_result_stale_hint")).font(.caption) }
                            Text(verbatim: result.head.map { String($0.prefix(7)) } ?? "—").font(.caption.monospaced())
                            DisclosureGroup(L.t("heavyslot_command_expand")) {
                                Text(verbatim: result.command).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("host-status-details")
    }

    private func resultLabel(_ result: Components.Schemas.HeavySlotSnapshot.LastResultsPayloadPayload.ResultPayload) -> String {
        switch result {
        case .passed: L.t("heavyslot_result_passed")
        case .failed: L.t("heavyslot_result_failed")
        case .aborted: L.t("heavyslot_result_aborted")
        }
    }

    private func section<Content: View>(_ key: StaticString, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: L.t(key)).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func row(_ key: StaticString, _ value: String) -> some View {
        LabeledContent { Text(verbatim: value).monospacedDigit() } label: { Text(verbatim: L.t(key)) }
    }
}
