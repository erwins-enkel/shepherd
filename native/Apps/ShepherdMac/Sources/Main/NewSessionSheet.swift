import Observation
import SwiftUI
import ShepherdKit

/// The sheet's busy/dismiss gate and create seam, pulled out of the view so it
/// is unit-testable without hosting SwiftUI (pattern: `LoginSheetState`,
/// `FirstRunSubmission`).
///
/// A class, not a struct, for the same reason `FirstRunSubmission` is one: the
/// view needs `busy` to flip visibly for the duration of the `await`, which a
/// struct's `self` inside an async mutating method cannot do.
@Observable
@MainActor
final class NewSessionSubmission {
    /// What the view should do once `submit` returns. Every case that leaves
    /// the sheet open has already written its own line into `message`.
    enum Outcome: Equatable {
        /// Created, and the store the request went to is still the active one:
        /// select this session and close the sheet.
        case created(Session)
        /// The usage hold tripped and the server queued the task instead of
        /// starting it. Nothing is selected; the sheet stays open saying so.
        case held
        /// The create failed; `message` says how.
        case failed
        /// Nothing to do: a create was already in flight, or the completion
        /// belongs to a sheet or a store the operator has moved on from.
        case dropped
    }

    private(set) var busy = false
    private(set) var message: String?
    /// Mirrors `LoginSheetState.canDismiss`: while a create is in flight the
    /// sheet's own close affordance must be blocked too, because dismissing
    /// does not cancel the untracked `Task` in `submit()` — a late success
    /// would otherwise select a session in a window whose sheet is gone.
    var canDismiss: Bool { !busy }

    /// Runs `create(request)` unless one is already in flight (a second call
    /// while `busy` is a no-op). `isCurrent` reports whether the sheet this
    /// submission started for is still the current one over the still-active
    /// store; false means the operator switched profiles or closed the sheet
    /// mid-flight, so the completion touches nothing and is logged at debug.
    @discardableResult
    func submit(
        _ request: CreateSessionRequest,
        using create: (CreateSessionRequest) async throws -> CreateOutcome,
        isCurrent: () -> Bool
    ) async -> Outcome {
        guard !busy else { return .dropped }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let outcome = try await create(request)
            guard isCurrent() else {
                Log.ui.debug("dropping a stale new-session completion")
                return .dropped
            }
            switch outcome {
            case .created(let session):
                return .created(session)
            case .held:
                message = L.t("native_newsession_held")
                return .held
            }
        } catch {
            guard isCurrent() else {
                Log.ui.debug("dropping a stale new-session failure")
                return .dropped
            }
            message = L.t("newtask_create_failed", ShepherdErrorCopy.message(error))
            return .failed
        }
    }
}

/// Covers exactly the CreateSessionRequest fields the contract marks as the
/// standard create: repoPath, baseBranch, prompt, agentProvider, model, effort.
struct NewSessionSheet: View {
    @Environment(AppModel.self) private var app

    @State private var repoPath = ""
    @State private var baseBranch = ""
    @State private var prompt = ""
    @State private var provider: AgentProvider = .claude
    @State private var modelName = ""
    @State private var effort: Effort?
    @State private var submission = NewSessionSubmission()
    /// Whether the provider picker has been settled — by the seed on
    /// appearance, by a late-arriving default, or by the operator choosing one.
    /// Only an unsettled picker may still be moved by arriving settings.
    @State private var didSeedProvider = false

    /// A git branch name, not operator-facing copy — it is the same literal the
    /// server falls back to, so it is not a catalog key.
    private static let defaultBaseBranch = "main"

    private var repos: [Repo] { (app.store?.repos ?? []).filter { !$0.hidden } }

    /// Choosing a provider by hand settles the picker, so a default that lands
    /// afterwards cannot move it back under the operator.
    private var providerSelection: Binding<AgentProvider> {
        Binding(
            get: { provider },
            set: { chosen in
                provider = chosen
                didSeedProvider = true
            })
    }

    /// What an arriving `defaultAgentProvider` should do: take effect while the
    /// picker is still unsettled, and nothing otherwise. Static and internal so
    /// the rule is unit-testable without hosting the sheet.
    static func arrivingProviderDefault(
        _ arriving: AgentProvider?, alreadySeeded: Bool
    ) -> AgentProvider? {
        guard !alreadySeeded, let arriving else { return nil }
        return arriving
    }

    private var canSubmit: Bool {
        !submission.busy
            && !repoPath.isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("newtask_title")).font(.title2.weight(.semibold))

            Form {
                Picker(L.t("newtask_repo_label"), selection: $repoPath) {
                    Text(verbatim: "—").tag("")
                    ForEach(repos, id: \.path) { repo in
                        Text(verbatim: repo.display).tag(repo.path)
                    }
                }
                .accessibilityIdentifier("newsession-repo")

                TextField(
                    L.t("newtask_branch_label"),
                    text: $baseBranch,
                    prompt: Text(verbatim: L.t("newtask_branch_placeholder")))

                Picker(L.t("native_newsession_provider_label"), selection: providerSelection) {
                    Text(verbatim: L.t("agent_provider_claude")).tag(AgentProvider.claude)
                    Text(verbatim: L.t("agent_provider_codex")).tag(AgentProvider.codex)
                }

                TextField(
                    L.t("newtask_model_label"),
                    text: $modelName,
                    prompt: Text(verbatim: L.t("newtask_model_default")))

                Picker(L.t("newtask_effort_label"), selection: $effort) {
                    Text(verbatim: L.t("effort_default")).tag(Effort?.none)
                    Text(verbatim: L.t("effort_label_low")).tag(Effort?.some(.low))
                    Text(verbatim: L.t("effort_label_medium")).tag(Effort?.some(.medium))
                    Text(verbatim: L.t("effort_label_high")).tag(Effort?.some(.high))
                    Text(verbatim: L.t("effort_label_xhigh")).tag(Effort?.some(.xhigh))
                    Text(verbatim: L.t("effort_label_max")).tag(Effort?.some(.max))
                    Text(verbatim: L.t("effort_label_ultra")).tag(Effort?.some(.ultra))
                }
            }
            .formStyle(.grouped)
            .disabled(submission.busy)

            Text(verbatim: L.t("newtask_prompt_label")).font(.callout.weight(.semibold))
            TextEditor(text: $prompt)
                .font(.body)
                .frame(minHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .overlay(alignment: .topLeading) {
                    // TextEditor has no `prompt:`, so the placeholder is drawn
                    // behind it and taken out of the accessibility tree — the
                    // editor itself is what VoiceOver should land on.
                    if prompt.isEmpty {
                        Text(verbatim: L.t("newtask_prompt_placeholder"))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .disabled(submission.busy)
                .accessibilityIdentifier("newsession-prompt")

            if let message = submission.message {
                Text(verbatim: message).font(.caption).foregroundStyle(.orange)
            }

            HStack {
                Button(L.t("common_cancel")) { app.sheet = nil }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submission.busy)
                Spacer()
                Button(submission.busy ? L.t("newtask_spawning") : L.t("newtask_submit")) {
                    submit()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
                .accessibilityIdentifier("newsession-submit")
            }
        }
        .padding(24)
        .frame(width: 620)
        .onAppear(perform: seedDefaults)
        // Repos arrive with the store's bootstrap, which may land after the
        // sheet is already up; without this the picker would sit on "—".
        .onChange(of: repos.first?.path) { _, first in
            if repoPath.isEmpty, let first { repoPath = first }
        }
        // Settings arrive with the same bootstrap. Seeded only on appearance,
        // the operator's configured default never reached a sheet opened before
        // it landed, and every session created from a cold-started window went
        // out with the picker's own `.claude`.
        .onChange(of: app.store?.settings?.defaultAgentProvider) { _, arriving in
            guard let next = Self.arrivingProviderDefault(arriving, alreadySeeded: didSeedProvider)
            else { return }
            provider = next
            didSeedProvider = true
        }
        // Mirrors the Cancel button's .disabled: Esc and click-outside must not
        // out-run the in-flight create either. See NewSessionSubmission.
        .interactiveDismissDisabled(!submission.canDismiss)
    }

    /// Defaults come from GET /api/settings and the first repo in the list.
    private func seedDefaults() {
        if repoPath.isEmpty { repoPath = repos.first?.path ?? "" }
        if baseBranch.isEmpty { baseBranch = Self.defaultBaseBranch }
        if let settings = app.store?.settings {
            provider = settings.defaultAgentProvider
            didSeedProvider = true
        }
    }

    private func submit() {
        guard let store = app.store, canSubmit else { return }

        let trimmedModel = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBranch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let request = CreateSessionRequest(
            repoPath: repoPath,
            baseBranch: trimmedBranch.isEmpty ? Self.defaultBaseBranch : trimmedBranch,
            prompt: prompt,
            agentProvider: provider,
            model: trimmedModel.isEmpty ? nil : trimmedModel,
            effort: effort)

        Task {
            // `store` is captured once, up front: the identity check below has
            // to compare against the store this create went to, not whichever
            // one happens to be active when it finishes.
            let outcome = await submission.submit(
                request,
                using: { try await store.create($0) },
                isCurrent: { app.store === store && app.sheet == .newSession })
            if case .created(let session) = outcome {
                app.selectedSessionID = session.id
                app.sheet = nil
                Log.ui.info("created session \(session.desig, privacy: .public)")
            }
        }
    }
}
