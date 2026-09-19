import SwiftUI
import ShepherdKit

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    @State private var localStatus: LocalServerStatus?
    @State private var probing = false
    @State private var remoteName = ""
    @State private var remoteAddress = ""
    @State private var remoteError: String?
    @State private var pendingLogin: ServerProfile?

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
        .sheet(item: $pendingLogin) { profile in
            LoginSheet(profile: profile) { pendingLogin = nil }
        }
    }

    // MARK: - Run on this Mac

    private var localCard: some View {
        // The card's own title is read fresh from the catalog rather than the
        // stored profile's `name` — `addLocalProfile()` persists the name at
        // the moment the row is created, so a later language switch would
        // otherwise leave this card showing the old language forever.
        WelcomeCard(title: L.t("native_welcome_local_title"), body: L.t("native_welcome_local_body")) {
            switch localStatus {
            case nil:
                Label(L.t("native_welcome_local_detecting"), systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            case .found(let version):
                Label(L.t("native_welcome_local_found", version), systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Button(L.t("native_welcome_connect")) { pendingLogin = model.addLocalProfile() }
                    .buttonStyle(.borderedProminent)
            case .absent:
                Label(L.t("native_welcome_local_missing"), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
                Button(L.t("native_welcome_local_recheck")) { Task { await refreshLocal() } }
                    .disabled(probing)
            }
        }
        .accessibilityIdentifier("welcome-local-card")
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
                        Task { await model.remove(profile) }
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.vertical, 6)
                .accessibilityIdentifier("welcome-saved-\(profile.id.uuidString)")
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("welcome-saved-servers")
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
            pendingLogin = try model.addRemoteProfile(name: remoteName, address: remoteAddress)
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
    }
}
