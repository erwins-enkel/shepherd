import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct SessionRow: View {
    let session: Session
    var content: SessionRowContent? = nil
    var onRepoFilter: (() -> Void)? = nil
    var repoFiltered = false
    @State private var showsDetails = false

    var body: some View {
        let copy = content ?? SessionRowContent(session: session, now: Int(Date.now.timeIntervalSince1970 * 1_000))
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                // A parked (done = WARTET) session is a hollow ring.
                Circle()
                    .fill(session.status.known == .done ? .clear : ShepherdPalette.statusTint(session.status))
                    .overlay { if session.status.known == .done { Circle().stroke(ShepherdPalette.slate, lineWidth: 2) } }
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(verbatim: session.name).lineLimit(1)
                    .modifier(ShepherdMonoFont(weight: .bold))
                    .foregroundStyle(ShepherdPalette.inkBright)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TimelineView(.periodic(from: .now, by: 1)) { timeline in
                    Button { showsDetails = true } label: {
                        Text(verbatim: SessionRowContent.elapsed(session.createdAt,
                            now: Int(timeline.date.timeIntervalSince1970 * 1_000)))
                            .modifier(ShepherdMonoFont(label: true))
                            .foregroundStyle(ShepherdPalette.muted)
                    }
                    .buttonStyle(.plain)
                    .fixedSize()
                    .help(L.t("native_session_details_title"))
                    .accessibilityIdentifier("session-clock-\(session.id)")
                }
            }
            HStack(spacing: 6) {
                if let onRepoFilter {
                    Button(action: onRepoFilter) { repository(copy.repository) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(repoFiltered
                            ? L.t("unitrow_repo_filter_clear_aria", copy.repository)
                            : L.t("unitrow_repo_filter_aria", copy.repository))
                        .accessibilityIdentifier("session-repo-\(session.id)")
                } else { repository(copy.repository) }
                Spacer(minLength: 0)
                Text(verbatim: SessionStatusStyle.label(session.status))
                    .modifier(ShepherdMonoFont(label: true, weight: .bold))
                    .foregroundStyle(ShepherdPalette.statusTint(session.status))
            }
            Text(verbatim: session.prompt)
                .modifier(ShepherdMonoFont())
                .foregroundStyle(ShepherdPalette.ink)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("session-prompt-\(session.id)")
            if let note = copy.note, !note.isEmpty {
                Text(verbatim: note)
                    .modifier(ShepherdMonoFont(label: true))
                    .foregroundStyle(ShepherdPalette.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("session-note-\(session.id)")
            }
            Button { showsDetails = true } label: {
                Text(verbatim: session.desig + " · " + copy.environment)
                    .modifier(ShepherdMonoFont(label: true))
                    .foregroundStyle(ShepherdPalette.muted)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(.plain)
            .help(L.t("native_session_details_title"))
            .accessibilityIdentifier("session-environment-\(session.id)")
            if let cold = copy.coldResume {
                Button { showsDetails = true } label: {
                    Label(cold, systemImage: "exclamationmark.triangle")
                        .modifier(ShepherdMonoFont(label: true))
                        .foregroundStyle(ShepherdPalette.amber)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session-cold-resume-\(session.id)")
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .popover(isPresented: $showsDetails) { details(copy) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session-row-\(session.id)")
    }

    private func repository(_ name: String) -> some View {
        Label(name, systemImage: "folder")
            .modifier(ShepherdMonoFont(label: true))
            .foregroundStyle(repoFiltered ? ShepherdPalette.amber : ShepherdPalette.muted)
            .lineLimit(1)
    }

    private func details(_ copy: SessionRowContent) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: L.t("native_session_details_title")).font(.headline)
                Text(verbatim: session.desig + " · " + session.name).font(.subheadline)
                detailSection(L.t("newtask_repo_label"), text: session.repoPath)
                let start = Date(timeIntervalSince1970: Double(session.createdAt) / 1_000)
                    .formatted(date: .abbreviated, time: .shortened)
                Text(verbatim: L.t("timetip_clock", SessionRowContent.elapsed(session.createdAt,
                    now: Int(Date.now.timeIntervalSince1970 * 1_000)), start))
                detailSection(L.t("newtask_prompt_label"), text: session.prompt)
                detailSection(L.t("newtask_model_label"), text: copy.modelNote)
                if let note = copy.effortNote { detailSection(L.t("newtask_effort_label"), text: note) }
                if let note = copy.coldResumeNote { detailSection(L.t("gloss_cold_cache_term"), text: note) }
            }
            .font(.callout)
            .textSelection(.enabled)
            .padding(16)
        }
        .frame(width: 360)
        .frame(maxHeight: 480)
        .accessibilityIdentifier("session-details-\(session.id)")
    }

    private func detailSection(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: title).font(.callout.weight(.semibold))
            Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
        }
    }
}

#if DEBUG
#Preview("Session rows") {
    List {
        SessionRow(session: PreviewData.session(status: SessionStatus(known: .running)))
        SessionRow(session: PreviewData.session(
            id: "s2", desig: "TASK-02", name: "blocked on review",
            status: SessionStatus(known: .blocked), agentProvider: .codex))
        SessionRow(session: PreviewData.session(
            id: "s3", desig: "TASK-03", name: "future status",
            status: SessionStatus(unknown: "quiescing"), agentProvider: nil))
    }
    .frame(width: 320)
}
#endif
