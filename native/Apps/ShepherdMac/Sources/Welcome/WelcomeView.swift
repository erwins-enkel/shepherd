import SwiftUI
import ShepherdKit

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    @State private var localStatus: LocalServerStatus?
    @State private var probing = false
    @State private var remoteName = ""
    @State private var remoteAddress = ""
    @State private var remoteError: String?
    /// The saved server whose Remove is waiting to be confirmed.
    @State private var pendingRemoval: ServerProfile?

    private let probe = LocalServerProbe()

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 6) {
                Text(verbatim: L.t("native_welcome_title")).font(.largeTitle.weight(.semibold))
                Text(verbatim: L.t("native_welcome_subtitle"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)
            }

            HStack(alignment: .top, spacing: 20) {
                localCard
                remoteCard
            }
            .frame(maxWidth: 820)

            if !model.savedServers.isEmpty {
                savedServers.frame(maxWidth: 820)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await refreshLocal() }
        // Remove revokes a token server-side and deletes a Keychain item —
        // neither is undoable, and the button sits one row away from Connect.
        // Pattern: the archive confirmation in MainWindow.
        .confirmationDialog(
            L.t("native_welcome_saved_remove_confirm_title", pendingRemoval?.name ?? ""),
            isPresented: confirmingRemoval,
            titleVisibility: .visible
        ) {
            if let profile = pendingRemoval {
                Button(L.t("native_welcome_saved_remove_confirm_action"), role: .destructive) {
                    pendingRemoval = nil
                    Task { await model.remove(profile) }
                }
            }
            Button(L.t("common_cancel"), role: .cancel) { pendingRemoval = nil }
        } message: {
            Text(verbatim: L.t("native_welcome_saved_remove_confirm_body"))
        }
    }

    /// Presented while a row is waiting for its answer; dismissing the dialog
    /// any other way (Esc, clicking away) drops that row again.
    private var confirmingRemoval: Binding<Bool> {
        Binding(
            get: { pendingRemoval != nil },
            set: { presented in if !presented { pendingRemoval = nil } })
    }

    // MARK: - Run on this Mac

    private var localCard: some View {
        // The card's own title is read fresh from the catalog rather than the
        // stored profile's `name` — `addLocalProfile()` persists the name at
        // the moment the row is created, so a later language switch would
        // otherwise leave this card showing the old language forever.
        WelcomeCard(title: L.t("native_welcome_local_title"), body: L.t("native_welcome_local_body")) {
            if let panel = WelcomeSlots.localPanel {
                panel(model)
            } else {
                builtInLocalControls
            }
        }
        .accessibilityIdentifier("welcome-local-card")
    }

    /// The probe-only controls Gate 2 shipped. S5 replaces them with real
    /// install/start controls through `WelcomeSlots.localPanel`. `@ViewBuilder`
    /// because a `switch` with several cases is not one `some View`.
    @ViewBuilder
    private var builtInLocalControls: some View {
        switch localStatus {
        case nil:
            Label(L.t("native_welcome_local_detecting"), systemImage: "hourglass")
                .foregroundStyle(.secondary)
        case .found(let version):
            Label(L.t("native_welcome_local_found", version), systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            // Routed through `model.sheet`, the app's one sheet channel:
            // a sheet this view presented itself would still be on screen
            // when a successful login swaps this screen for the main
            // window, and the `.firstRun` routed behind it would never be
            // presented.
            Button(L.t("native_welcome_connect")) { model.beginLocalLogin() }
                .buttonStyle(.borderedProminent)
        case .absent:
            Label(L.t("native_welcome_local_missing"), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
            Button(L.t("native_welcome_local_recheck")) { Task { await refreshLocal() } }
                .disabled(probing)
        }
    }

    private func refreshLocal() async {
        probing = true
        defer { probing = false }
        localStatus = await probe.probe()
    }

    // MARK: - Saved servers

    /// The way back to a profile that is already set up. Without it, a stored
    /// server could only be reached by typing its address again, which appends
    /// a *duplicate* row with a fresh `credentialKey` — and leaves the original
    /// row's token live under a row nothing can revoke it from.
    ///
    /// Connect does not ask for a password: the token is still in the Keychain,
    /// and the connection watcher routes to the login sheet by itself if it has
    /// gone missing or the server no longer honours it.
    private var savedServers: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: L.t("native_welcome_saved_title")).font(.title3.weight(.semibold))

            ForEach(model.savedServers) { profile in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: profile.name).font(.callout.weight(.medium))
                        Text(verbatim: profile.baseURL.host() ?? profile.baseURL.absoluteString)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Button(L.t("native_welcome_saved_connect")) {
                        Task { await model.activate(profile) }
                    }
                    .accessibilityIdentifier("welcome-saved-connect-\(profile.id.uuidString)")
                    // Removal revokes the token and deletes the Keychain item,
                    // which is why it is the secondary affordance here.
                    Button(L.t("native_welcome_saved_remove"), role: .destructive) {
                        pendingRemoval = profile
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.vertical, 6)
                .accessibilityIdentifier("welcome-saved-\(profile.id.uuidString)")
                // See WelcomeCard's own `.accessibilityElement(children: .contain)`:
                // without it the row's identifier would swallow the connect and
                // remove buttons' own identifiers.
                .accessibilityElement(children: .contain)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("welcome-saved-servers")
        .accessibilityElement(children: .contain)
    }

    // MARK: - Connect to a remote server

    private var remoteCard: some View {
        WelcomeCard(title: L.t("native_welcome_remote_title"), body: L.t("native_welcome_remote_body")) {
            TextField(
                L.t("native_welcome_remote_name_label"),
                text: $remoteName,
                prompt: Text(verbatim: L.t("native_welcome_remote_name_placeholder"))
            )
            .textFieldStyle(.roundedBorder)

            TextField(
                L.t("native_welcome_remote_url_label"),
                text: $remoteAddress,
                prompt: Text(verbatim: L.t("native_welcome_remote_url_placeholder"))
            )
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("welcome-remote-url")
            .onSubmit { connectRemote() }

            if let remoteError {
                Text(verbatim: remoteError).font(.caption).foregroundStyle(.red)
            }

            Button(L.t("native_welcome_connect")) { connectRemote() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("welcome-remote-connect")
        }
        .accessibilityIdentifier("welcome-remote-card")
    }

    private func connectRemote() {
        do {
            remoteError = nil
            try model.beginRemoteLogin(name: remoteName, address: remoteAddress)
        } catch {
            // One mapper for everything: RemoteServerForm.FieldError for a typo,
            // ShepherdKit's ServerProfileError for an address the policy rejects.
            remoteError = ShepherdErrorCopy.message(error)
        }
    }
}

/// Shared card chrome for the two welcome options.
private struct WelcomeCard<Content: View>: View {
    private let title: String
    private let blurb: String
    private let content: Content

    init(title: String, body: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.blurb = body
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: title).font(.title3.weight(.semibold))
            Text(verbatim: blurb)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
        // Without this, macOS's AX bridge collapses every descendant's own
        // accessibilityIdentifier (the text field, the connect button, …) onto
        // whatever identifier the card container carries — `.contain` keeps
        // this view as a group and lets each child stay its own AX element.
        .accessibilityElement(children: .contain)
    }
}
