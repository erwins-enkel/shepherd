import ShepherdKit
import SwiftUI

struct ComposeActionSheet: View {
    let mode: ComposeActions.Action
    let session: Session?
    let store: SessionStore
    let app: AppModel
    let activation: Int
    @Environment(\.dismiss) private var dismiss
    @State private var actions: ComposeActions

    init(mode: ComposeActions.Action, session: Session?, store: SessionStore, app: AppModel, activation: Int) {
        self.mode = mode; self.session = session; self.store = store; self.app = app; self.activation = activation
        _actions = State(initialValue: ComposeActions(provider: session?.agentProvider ?? .claude))
    }
    private var current: Bool { app.store === store && app.activationGeneration == activation }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: mode.title).font(.title2.bold())
            if let session { Text(verbatim: session.name).foregroundStyle(.secondary) }
            if mode == .steers {
                if actions.loaded { ComposeSteersEditor(actions: actions, repos: store.repos) }
            } else if mode == .close {
                closeContents
            } else {
                choice
                if mode == .replace {
                    Text(verbatim: L.t("experiment_continue_scope")).font(.callout)
                    Picker(L.t("experiment_continue_handoff_label"), selection: $actions.handoff) {
                        Text(verbatim: L.t("experiment_continue_mode_resume")).tag(ComposeReplaceRequest.HandoffModePayload.resume)
                        Text(verbatim: L.t("experiment_continue_mode_summarize")).tag(ComposeReplaceRequest.HandoffModePayload.summarize)
                    }
                }
                if let prompt = actions.recommendation {
                    ScrollView { Text(verbatim: prompt).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(minHeight: 100, maxHeight: 240)
                        .accessibilityLabel(L.t("recommend_result_hint"))
                    Button(L.t("recommend_inject")) {
                        guard let session else { return }
                        Task {
                            await actions.run(operation: { try await store.client.replySession(id: session.id, text: prompt) },
                                              apply: { _ in dismiss() }, isCurrent: { current })
                        }
                    }.disabled(actions.busy)
                    ShareLink(item: prompt) { Text(verbatim: L.t("native_compose_share_prompt")) }
                }
            }
            if actions.busy { ProgressView(mode == .recommend ? L.t("recommend_loading") : L.t("common_loading")) }
            if let error = actions.error { Text(verbatim: error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button(L.t("common_cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                if [.steers, .close].contains(mode) && !actions.loaded {
                    Button(L.t("common_retry")) { Task { await load() } }.disabled(actions.busy || !current)
                }
                Button(confirmTitle) { Task { await confirm() } }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(!canConfirm)
            }
        }
        .padding(24).frame(width: mode == .steers ? 650 : 540)
        .disabled(!current)
        .interactiveDismissDisabled(actions.busy)
        .task { await load() }
        .onDisappear { actions.teardown() }
        .accessibilityIdentifier("compose.action.\(mode.rawValue)")
    }

    private var canConfirm: Bool {
        guard current, !actions.busy else { return false }
        switch mode {
        case .steers: return actions.loaded && actions.canSaveSteers
        case .close: return actions.loaded && session != nil
        default: return session != nil
        }
    }
    private var confirmTitle: String {
        switch mode {
        case .variant: L.t("experiment_variant_confirm")
        case .replace: L.t("experiment_replace_confirm")
        case .recommend: L.t("recommend_title")
        case .close: L.t("leftover_close_only")
        case .steers: L.t("common_save")
        }
    }
    private var choice: some View {
        VStack {
            Picker(L.t("newtask_agent_provider_label"), selection: $actions.provider) {
                Text(verbatim: EnginePicker.name(.claude)).tag(AgentProvider.claude)
                Text(verbatim: EnginePicker.name(.codex)).tag(AgentProvider.codex)
            }
            Picker(L.t("newtask_model_label"), selection: $actions.model) {
                if mode != .recommend { Text(verbatim: L.t("newtask_model_default")).tag("default") }
                ForEach(ComposeRunConfig.providerModels(actions.provider).filter { ComposeRunConfig.available($0, provider: actions.provider, fableAvailable: store.settings?.additionalProperties.value["fableAvailable"] as? Bool ?? true) }, id: \.self) { model in
                    Text(verbatim: model).tag(model)
                }
            }
            if mode != .recommend {
                Picker(L.t("newtask_effort_label"), selection: $actions.effort) {
                    ForEach(actions.efforts, id: \.self) { Text(verbatim: EffortPicker.label($0)).tag($0) }
                }
            }
        }
        .disabled(actions.busy)
        .onChange(of: actions.provider) { _, _ in seedRecommendationModel() }
    }
    private var closeContents: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: L.t("native_archive_confirm_body"))
            if let listing = actions.leftovers {
                if listing.probesUnavailable {
                    Text(verbatim: L.t("native_compose_probes_unavailable")).foregroundStyle(.orange)
                }
                if !listing.leftovers.isEmpty {
                    Text(verbatim: L.t("leftover_title")).font(.headline)
                    ScrollView {
                        ForEach(Array(listing.leftovers.enumerated()), id: \.offset) { _, item in
                            HStack {
                                Text(verbatim: item.name)
                                Spacer()
                                if let port = item.port { Text(verbatim: L.t("leftover_port", String(port))) }
                            }
                        }
                    }.frame(maxHeight: 180)
                    Text(verbatim: L.t("native_compose_leftovers_kept")).font(.callout)
                }
            }
        }
    }
    private func seedRecommendationModel() {
        if mode == .recommend { actions.model = actions.provider == .claude ? "opus" : "gpt-5.5" }
    }
    private func load() async {
        switch mode {
        case .steers:
            await actions.run(operation: { try await store.client.steers() }, apply: {
                actions.steers = $0; actions.loaded = true
            }, isCurrent: { current })
        case .close:
            guard let session else { return }
            await actions.run(operation: { try await store.client.sessionLeftovers(id: session.id) }, apply: {
                actions.leftovers = $0; actions.loaded = true
            }, isCurrent: { current })
        case .recommend: seedRecommendationModel()
        default: break
        }
    }
    private func confirm() async {
        guard canConfirm else { return }
        if mode == .steers {
            let snapshot = actions.steers
            await actions.run(operation: { try await store.client.saveSteers(snapshot) }, apply: { _ in dismiss() }, isCurrent: { current })
            return
        }
        guard let session else { return }
        switch mode {
        case .variant:
            let request = actions.variantRequest
            await actions.run(operation: { try await store.client.startVariant(id: session.id, choice: request) }, apply: select, isCurrent: { current })
        case .replace:
            let request = actions.replaceRequest
            await actions.run(operation: { try await store.client.replaceSessionAgent(id: session.id, choice: request) }, apply: select, isCurrent: { current })
        case .recommend:
            let provider = actions.provider, model = actions.model
            await actions.run(operation: { try await store.client.recommendPrompt(id: session.id, provider: provider, model: model) }, apply: {
                actions.recommendation = $0
            }, isCurrent: { current })
        case .close:
            await actions.run(operation: { try await store.client.archiveSession(id: session.id) }, apply: { _ in
                store.apply(.sessionArchived(.init(id: session.id))); dismiss()
            }, isCurrent: { current })
        case .steers: break
        }
    }
    private func select(_ session: Session) {
        store.apply(.sessionNew(session)); app.selectedSessionID = session.id; dismiss()
    }
}
