import SwiftUI
import ShepherdKit

enum BannerKind: Equatable, Sendable {
    case offline(server: String)
    case versionMismatch(server: String, app: String)
    /// The server declares a minimum client version this build does not meet.
    /// Distinct from `versionMismatch` because it is not a "some things may not
    /// work" warning: the server has said outright that this app is too old,
    /// and the only fix is an update.
    case clientTooOld(minimum: String, app: String)
    case needsLogin

    var message: String {
        switch self {
        case .offline(let server): L.t("native_banner_offline", server)
        case .versionMismatch(let server, let app): L.t("native_banner_mismatch", server, app)
        case .clientTooOld(let minimum, let app): L.t("native_banner_client_too_old", minimum, app)
        case .needsLogin: L.t("native_banner_needs_login")
        }
    }

    var systemImage: String {
        switch self {
        case .offline: "wifi.exclamationmark"
        case .versionMismatch: "exclamationmark.triangle"
        case .clientTooOld: "arrow.down.circle"
        case .needsLogin: "lock"
        }
    }
}

/// Dotted-numeric version ordering, which is all the `major.minor.patch`
/// strings on both sides of this contract need.
///
/// Plain string comparison is wrong here — "3.9.0" sorts *after* "3.41.0" — and
/// a full semver implementation is more than a banner deserves. A pre-release
/// or build suffix is dropped before comparing, so `3.42.0-rc.1` counts as
/// `3.42.0`. Anything that does not parse as numbers compares as "not older":
/// an unexpected version format degrades to silence rather than to a banner the
/// operator has no way to act on.
enum AppVersion {
    static func isOlder(_ lhs: String, than rhs: String) -> Bool {
        guard let left = components(lhs), let right = components(rhs) else { return false }
        for index in 0..<max(left.count, right.count) {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l != r { return l < r }
        }
        return false
    }

    private static func components(_ value: String) -> [Int]? {
        let release = value.trimmingCharacters(in: .whitespaces).prefix { $0 != "-" && $0 != "+" }
        guard !release.isEmpty else { return nil }
        var numbers: [Int] = []
        for part in release.split(separator: ".", omittingEmptySubsequences: false) {
            guard let number = Int(part), number >= 0 else { return nil }
            numbers.append(number)
        }
        return numbers.isEmpty ? nil : numbers
    }
}

/// Decides which non-blocking banner (if any) the main window shows.
///
/// `.firstRunPending` is deliberately silent — FirstRunSheet handles it — and so
/// is `.idle`, which only means "no store is running yet". Command failures
/// (`badRequest`, `conflict`, …) are reported inline by the sheet that caused
/// them, so the only `lastError` this policy reacts to is `.contractMismatch`.
///
/// `lastError` is a parameter because `ConnectionState.offline` carries a
/// *message*, not an error value: `SessionStore` maps only
/// `ShepherdError.transport` onto it. A contract mismatch is a different animal
/// — the socket is fine, the payloads are not — so it lands in
/// `SessionStore.lastError` while `connection` may still read `.live`.
enum BannerPolicy {
    static func kind(
        for state: ConnectionState,
        lastError: ShepherdError?,
        serverName: String,
        serverVersion: String?,
        appVersion: String,
        minClient: String? = nil
    ) -> BannerKind? {
        // Two grades of version trouble, most specific first. "Too old" is a
        // statement by the server; a plain difference is only a suspicion, and
        // saying both at once would be noise.
        let versionBanner: BannerKind? = {
            if let minClient, AppVersion.isOlder(appVersion, than: minClient) {
                return .clientTooOld(minimum: minClient, app: appVersion)
            }
            guard let serverVersion, serverVersion != appVersion else { return nil }
            return .versionMismatch(server: serverVersion, app: appVersion)
        }()

        let sawContractMismatch: Bool = {
            guard let lastError, case .contractMismatch = lastError else { return false }
            return true
        }()

        switch state {
        case .idle, .connecting, .firstRunPending:
            return nil
        case .needsLogin:
            return .needsLogin
        case .live:
            return versionBanner
        case .offline:
            // A decode failure against a server we can name a version for is a
            // version problem, not a network problem — say the useful thing.
            if sawContractMismatch, let versionBanner { return versionBanner }
            return .offline(server: serverName)
        }
    }
}

struct ConnectionBanner: View {
    let kind: BannerKind
    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: kind.systemImage)
                .accessibilityHidden(true)
            Text(verbatim: kind.message)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button(L.t("common_retry"), action: onRetry).buttonStyle(.link)
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.yellow.opacity(0.18))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityIdentifier("connection-banner")
    }
}

#if DEBUG
#Preview("Banners") {
    VStack(spacing: 0) {
        ConnectionBanner(kind: .offline(server: "Studio")) {}
        ConnectionBanner(kind: .versionMismatch(server: "3.42.0", app: "3.41.0")) {}
        ConnectionBanner(kind: .clientTooOld(minimum: "3.42.0", app: "3.41.0")) {}
        ConnectionBanner(kind: .needsLogin) {}
    }
    .frame(width: 640)
}
#endif
