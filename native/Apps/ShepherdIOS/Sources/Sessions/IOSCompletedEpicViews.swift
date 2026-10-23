import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// "Epics to land" (#2857): the band's colours, by tone. Green is ready to land only; a landed
/// or quiet row stays slate.
enum IOSCompletedEpicTone {
    static func accent(_ tone: CompletedEpicTone) -> Color {
        switch tone {
        case .quiet: SessionListStyle.slate
        case .warn: SessionListStyle.warn
        case .ready: SessionListStyle.green
        }
    }

    static func border(_ tone: CompletedEpicTone) -> Color {
        tone == .quiet ? SessionListStyle.line : accent(tone).opacity(0.5)
    }
}

/// The band's head: title, the "waiting on you" chip and the explanation link.
struct IOSCompletedEpicsHeader: View {
    let count: Int
    let waiting: Int
    let collapsed: Bool
    let toggle: () -> Void
    let explain: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .foregroundStyle(SessionListStyle.muted)
                    Text(verbatim: CompletedEpicsBand.title(count: count).uppercased())
                        .foregroundStyle(SessionListStyle.bright)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if waiting > 0 {
                        Text(verbatim: CompletedEpicsBand.waitingLabel(waiting))
                            .sessionFont(label: true, weight: .bold)
                            .foregroundStyle(SessionListStyle.background)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(SessionListStyle.warn, in: RoundedRectangle(cornerRadius: 2))
                    }
                }
                .sessionFont(label: true, weight: .semibold)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(collapsed ? L.t("native_ios_group_collapsed") : L.t("native_ios_group_expanded"))
            .accessibilityIdentifier("herd-epics-to-land")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { summary; how }
                VStack(alignment: .leading, spacing: 0) { summary; how }
            }
        }
    }

    private var summary: some View {
        Text(verbatim: L.t("integrated_epics_band_summary"))
            .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var how: some View {
        Button(action: explain) {
            Text(verbatim: L.t("integrated_epics_how")).underline()
                .sessionFont(label: true).foregroundStyle(SessionListStyle.ink)
                .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("herd-epics-to-land-how")
    }
}

/// One epic to land, collapsed or open. Pure rendering of `CompletedEpicCard`.
struct IOSCompletedEpicCardView: View {
    let card: CompletedEpicCard
    var serverName: String?
    let expanded: Bool
    let childrenExpanded: Bool
    /// False on a read-only connection: the card shows, its actions do not.
    let canAct: Bool
    let starting: Bool
    let toggle: () -> Void
    let toggleChildren: () -> Void
    let perform: (CompletedEpicCard.Action) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    private var tone: Color { IOSCompletedEpicTone.accent(card.status.tone) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head.padding(.horizontal, 12)
            if expanded {
                VStack(alignment: .leading, spacing: 14) {
                    path
                    nextStep
                    childrenSection
                }
                .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 4)
                if card.showsFooter, canAct { footer }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SessionListStyle.panel)
        .overlay { Rectangle().stroke(IOSCompletedEpicTone.border(card.status.tone), lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("epic-to-land-\(card.parentNumber)")
    }

    // MARK: Head

    private var head: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    Text(verbatim: card.identity).foregroundStyle(SessionListStyle.ink)
                    Text(verbatim: card.repoName).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(verbatim: card.finished).fixedSize()
                }
                .sessionFont(label: true)
                .foregroundStyle(SessionListStyle.muted)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: "\(expanded ? card.collapseLabel : card.expandLabel): \(card.title)"))
            Text(verbatim: card.title)
                .sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
                .lineLimit(typeSize.isAccessibilitySize ? nil : (expanded ? 3 : 1))
                .padding(.top, -6)
            chips
            if let serverName { IOSServerHint(name: serverName) }
        }
        .padding(.bottom, expanded ? 0 : 12)
    }

    private var chips: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                turnChip
                if !expanded {
                    Text(verbatim: card.summary).sessionFont(label: true).foregroundStyle(SessionListStyle.ink)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                }
            }
            ForEach(card.flags, id: \.self) { flag in
                Text(verbatim: flag.uppercased())
                    .sessionFont(label: true, weight: .bold).foregroundStyle(SessionListStyle.warn)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.warn, lineWidth: 1) }
            }
        }
    }

    @ViewBuilder private var turnChip: some View {
        let label = Text(verbatim: card.turnLabel).sessionFont(label: true, weight: .bold)
            .padding(.horizontal, 7).padding(.vertical, 3)
        if card.status.tone == .quiet {
            label.foregroundStyle(SessionListStyle.muted)
                .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
                .fixedSize()
        } else {
            label.foregroundStyle(SessionListStyle.background)
                .background(tone, in: RoundedRectangle(cornerRadius: 2))
                .fixedSize()
        }
    }

    // MARK: Path to main

    private var path: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: L.t("integrated_epics_path_heading").uppercased())
                .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(card.steps) { step in
                    stepRow(step, last: step.id == card.steps.last?.id)
                }
            }
        }
    }

    private func stepRow(_ step: CompletedEpicCard.Step, last: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                IOSCompletedEpicMarker(marker: step.marker)
                Rectangle().fill(last ? Color.clear : SessionListStyle.brightLine).frame(width: 1)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                if let url = step.url {
                    Button { perform(.openURL(url)) } label: {
                        Text(verbatim: step.label).underline()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(stepText(step.marker))
                } else {
                    Text(verbatim: step.label).foregroundStyle(stepText(step.marker))
                }
                if let detail = step.detail {
                    Text(verbatim: detail).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            .sessionFont()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, last ? 0 : 14)
            Text(verbatim: step.value).sessionFont(label: true).foregroundStyle(IOSCompletedEpicMarker.tint(step.marker))
                .fixedSize()
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: step.value.isEmpty ? step.label : "\(step.label), \(step.value)"))
    }

    private func stepText(_ marker: CompletedEpicCard.Marker) -> Color {
        marker == .done || marker == .open ? SessionListStyle.muted : SessionListStyle.bright
    }

    // MARK: Next step

    private var nextStep: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L.t("integrated_epics_next_heading").uppercased())
                .sessionFont(label: true)
                .foregroundStyle(card.status.tone == .quiet ? SessionListStyle.muted : tone)
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: card.heading).sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: card.body).sessionFont().foregroundStyle(SessionListStyle.ink)
                .fixedSize(horizontal: false, vertical: true)
            if canAct { actions }
            ForEach(card.notes, id: \.self) { note in
                Text(verbatim: note).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(card.status.tone == .quiet ? SessionListStyle.background : tone.opacity(0.07))
        .overlay {
            RoundedRectangle(cornerRadius: 3)
                .stroke(card.status.tone == .quiet ? SessionListStyle.brightLine : tone.opacity(0.6), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(card.buttons) { button in
                actionButton(button)
            }
            if let busy = card.busyLabel {
                Text(verbatim: busy).sessionFont().foregroundStyle(SessionListStyle.muted)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay { RoundedRectangle(cornerRadius: 3)
                        .stroke(SessionListStyle.brightLine, style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let reason = card.lockedReason {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { locked; lockedReason(reason) }
                    VStack(alignment: .leading, spacing: 4) { locked; lockedReason(reason) }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.top, 6)
    }

    private func actionButton(_ button: CompletedEpicCard.ActionButton) -> some View {
        let busy = starting && (button.action == .repairCi || button.action == .resolveConflicts)
        let fill = card.status.tone == .quiet ? SessionListStyle.slate : tone
        return Button { perform(button.action) } label: {
            Text(verbatim: button.label)
                .sessionFont(weight: button.prominent ? .bold : .regular)
                .foregroundStyle(button.prominent
                    ? (card.status.tone == .quiet ? SessionListStyle.bright : SessionListStyle.background)
                    : SessionListStyle.ink)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(button.prominent ? fill : Color.clear, in: RoundedRectangle(cornerRadius: 3))
                .overlay {
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(button.prominent ? fill : SessionListStyle.brightLine, lineWidth: 1)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.5 : 1)
        .accessibilityIdentifier("epic-to-land-action-\(button.label)")
    }

    private var locked: some View {
        Label {
            Text(verbatim: L.t("integrated_epics_land"))
        } icon: {
            Image(systemName: "lock")
        }
        .sessionFont().foregroundStyle(SessionListStyle.muted)
        .padding(.horizontal, 14).frame(minHeight: 44)
        .overlay {
            RoundedRectangle(cornerRadius: 3)
                .stroke(SessionListStyle.brightLine, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        }
        .accessibilityAddTraits(.isButton)
        .accessibilityRemoveTraits(.isStaticText)
    }

    private func lockedReason(_ reason: String) -> some View {
        Text(verbatim: reason).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Children

    private var childrenSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggleChildren) {
                HStack(spacing: 6) {
                    Image(systemName: childrenExpanded ? "chevron.down" : "chevron.right")
                    Text(verbatim: card.childrenHeading.uppercased())
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(childrenExpanded ? L.t("native_ios_group_expanded") : L.t("native_ios_group_collapsed"))
            if childrenExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(card.children) { child in childRow(child) }
                }
                .padding(.leading, 18).padding(.bottom, 6)
            }
        }
    }

    private func childRow(_ child: CompletedEpicCard.Child) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: child.integrated ? "checkmark" : "minus")
                .foregroundStyle(child.integrated ? SessionListStyle.muted : SessionListStyle.amber)
                .frame(width: 14)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let url = child.url {
                        Button { perform(.openURL(url)) } label: { Text(verbatim: child.ref).underline() }
                            .buttonStyle(.plain)
                            .sessionFont().foregroundStyle(SessionListStyle.ink)
                    } else {
                        Text(verbatim: child.ref).sessionFont().foregroundStyle(SessionListStyle.ink)
                    }
                    Spacer(minLength: 6)
                    Text(verbatim: child.note).sessionFont(label: true)
                        .foregroundStyle(child.integrated ? SessionListStyle.muted : SessionListStyle.amber)
                        .lineLimit(1)
                }
                if let title = child.title {
                    Text(verbatim: title).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    // MARK: Footer

    private var footer: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { removeButton; removeHint }
            VStack(alignment: .leading, spacing: 0) { removeButton; removeHint.padding(.bottom, 8) }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.line).frame(height: 1) }
    }

    private var removeButton: some View {
        Button { perform(.dismiss) } label: {
            Text(verbatim: L.t("integrated_epics_dismiss")).underline()
                .sessionFont().foregroundStyle(SessionListStyle.ink)
                .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text(verbatim: L.t("integrated_epics_dismiss_hint")))
    }

    private var removeHint: some View {
        Text(verbatim: L.t("integrated_epics_dismiss_hint")).sessionFont(label: true)
            .foregroundStyle(SessionListStyle.muted)
            .accessibilityHidden(true)
    }
}

/// A "Path to main" marker: a ring whose glyph and colour say the step's state, never colour alone.
struct IOSCompletedEpicMarker: View {
    let marker: CompletedEpicCard.Marker

    static func tint(_ marker: CompletedEpicCard.Marker) -> Color {
        switch marker {
        case .done, .open: SessionListStyle.muted
        case .running: SessionListStyle.amber
        case .failure: SessionListStyle.red
        case .warn: SessionListStyle.warn
        case .ready: SessionListStyle.green
        }
    }

    var body: some View {
        let tint = Self.tint(marker)
        let ring = marker == .done ? SessionListStyle.slate : marker == .open ? SessionListStyle.brightLine : tint
        let filled = marker == .failure || marker == .warn || marker == .ready
        ZStack {
            Circle().fill(filled ? tint.opacity(0.14) : Color.clear)
            Circle().stroke(ring, lineWidth: 1.5)
            glyph.font(.system(size: 9, weight: .bold)).foregroundStyle(tint)
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var glyph: some View {
        switch marker {
        case .done, .ready: Image(systemName: "checkmark")
        case .failure: Image(systemName: "xmark")
        case .warn: Image(systemName: "exclamationmark")
        case .running: Circle().frame(width: 7, height: 7)
        case .open: EmptyView()
        }
    }
}

/// "How it works": the web's explanation, as a sheet.
struct IOSCompletedEpicsHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: L.t("integrated_epics_help_summary"))
                        .sessionFont().foregroundStyle(SessionListStyle.bright)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 18)
                    section(L.t("integrated_epics_help_landing_label"), L.t("integrated_epics_help_landing"))
                    section(L.t("integrated_epics_help_you_label"), L.t("integrated_epics_help_you"))
                    section(L.t("integrated_epics_dismiss"), L.t("integrated_epics_help_remove"))
                    section(L.t("integrated_epics_help_excluded_label"), L.t("integrated_epics_help_excluded"))
                        .overlay(alignment: .bottom) { Rectangle().fill(SessionListStyle.line).frame(height: 1) }
                }
                .padding()
            }
            .background(SessionListStyle.panel)
            .navigationTitle(L.t("integrated_epics_help_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(L.t("common_close")) { dismiss() }
            } }
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
        .tint(SessionListStyle.amber)
    }

    private func section(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: label.uppercased()).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: text).sessionFont().foregroundStyle(SessionListStyle.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(SessionListStyle.line).frame(height: 1) }
    }
}
