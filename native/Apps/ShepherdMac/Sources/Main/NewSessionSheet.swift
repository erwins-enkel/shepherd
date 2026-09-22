import ShepherdAppCore
import Observation
import SwiftUI
import ShepherdKit

/// Covers exactly the CreateSessionRequest fields the contract marks as the
/// standard create: repoPath, baseBranch, prompt, agentProvider, model, effort.
struct NewSessionSheet: View {
    @Environment(AppModel.self) private var app

    @State private var repoPath = ""
    @State private var baseBranch = ""
    @State private var prompt = ""
    @State private var modelName = ""
    @State private var effort: Effort?
    @State private var submission = NewSessionSubmission()
    @State private var providerSelection = ProviderSelection()
    /// The contract-legal create fields the built-in form does not show. Owned here so the sheet's
    /// lifetime is the extras' lifetime; filled by `NewSessionSlot.options` when a stream sets it.
    @State private var extras = NewSessionExtras()

    /// A git branch name, not operator-facing copy — it is the same literal the
    /// server falls back to, so it is not a catalog key.
    private static let defaultBaseBranch = "main"

    private var repos: [Repo] { (app.store?.repos ?? []).filter { !$0.hidden } }

    /// Any use of the picker settles it, so a default that lands afterwards
    /// cannot move it back under the operator.
    private var providerBinding: Binding<AgentProvider> {
        Binding(get: { providerSelection.provider }, set: { providerSelection.choose($0) })
    }

    /// What an arriving `defaultAgentProvider` should do: take effect while the
    /// picker is still unsettled, and nothing otherwise. Static and internal so
    /// the rule is unit-testable without hosting the sheet.
    static func arrivingProviderDefault(
        _ arriving: AgentProvider?, alreadySeeded: Bool
    ) -> AgentProvider? {
        ProviderSelection.arrivingProviderDefault(arriving, alreadySeeded: alreadySeeded)
    }

    private var canSubmit: Bool {
        !submission.busy
            && !repoPath.isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The same selection the view renders, callable without a SwiftUI host in seam tests.
    enum ResolvedBody {
        case slot(AnyView)
        case fallback(options: AnyView?)
    }

    static func resolveBody(app: AppModel, extras: NewSessionExtras) -> ResolvedBody {
        if let content = NewSessionSlot.content {
            return .slot(content(app))
        } else {
            return .fallback(options: NewSessionSlot.options?(extras))
        }
    }

    /// Shared by submission and seam tests so the options use the outgoing request's extras.
    static func createRequest(
        _ base: CreateSessionRequest, extras: NewSessionExtras
    ) -> CreateSessionRequest {
        var request = base
        extras.apply(to: &request)
        return request
    }

    var body: some View {
        switch Self.resolveBody(app: app, extras: extras) {
        case .slot(let content):
            content
        case .fallback(let options):
            builtInBody(options: options)
        }
    }

    /// The Gate-2 sheet, unchanged apart from the options hook. Split out rather than wrapped in
    /// place so the replacement branch above is one line and this stays diff-clean for whoever
    /// reads it next.
    private func builtInBody(options: AnyView?) -> some View {
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

                Picker(L.t("native_newsession_provider_label"), selection: providerBinding) {
                    Text(verbatim: L.t("agent_provider_claude")).tag(AgentProvider.claude)
                    Text(verbatim: L.t("agent_provider_codex")).tag(AgentProvider.codex)
                }
                // The binding's `set` never fires for a re-selection of the
                // value already shown, so the interaction itself is what
                // settles the picker. `simultaneousGesture` rather than
                // `onTapGesture`: the menu must still open.
                .simultaneousGesture(TapGesture().onEnded { providerSelection.touch() })

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
                if let options {
                    options
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
            providerSelection.applyArrivingDefault(arriving)
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
            providerSelection.seed(settings.defaultAgentProvider)
        }
    }

    private func submit() {
        guard let store = app.store, canSubmit else { return }

        let trimmedModel = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBranch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = CreateSessionRequest(
            repoPath: repoPath,
            baseBranch: trimmedBranch.isEmpty ? Self.defaultBaseBranch : trimmedBranch,
            prompt: prompt,
            agentProvider: providerSelection.provider,
            model: trimmedModel.isEmpty ? nil : trimmedModel,
            effort: effort)
        // Only what the operator actually set — see NewSessionExtras.apply(to:).
        let request = Self.createRequest(base, extras: extras)

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
