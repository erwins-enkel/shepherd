import SwiftUI
import ShepherdKit

enum BannerKind: Equatable, Sendable {
    case offline(server: String)
    /// The server and this app disagree about the *payloads*, not the version
    /// numbers. Raised only by an actual `ShepherdError.contractMismatch`: the
    /// app's `MARKETING_VERSION` and the server's `package.json` version are
    /// different version lines, so a plain inequality between them would be
    /// true on every healthy connection and the banner would never go away.
    case contractMismatch(server: String, app: String)
    /// The server declares a minimum client version this build does not meet.
    /// Distinct from `contractMismatch` because nothing has failed yet: the
    /// server has said outright that this app is too old, and the only fix is
    /// an update.
    case clientTooOld(minimum: String, app: String)
    case needsLogin

    var message: String {
        switch self {
        case .offline(let server): L.t("native_banner_offline", server)
        case .contractMismatch(let server, let app): L.t("native_banner_mismatch", server, app)
        case .clientTooOld(let minimum, let app): L.t("native_banner_client_too_old", minimum, app)
        case .needsLogin: L.t("native_banner_needs_login")
        }
    }

    var systemImage: String {
        switch self {
        case .offline: "wifi.exclamationmark"
        case .contractMismatch: "exclamationmark.triangle"
        case .clientTooOld: "arrow.down.circle"
        case .needsLogin: "lock"
        }
    }
}

/// A `major.minor.patch[-prerelease][+build]` version under SemVer 2.0
/// precedence (§11), which is the ordering `Health.minClient` is specified in.
///
/// Anything that is not a version this build can read parses to `nil` rather
/// than to a guess: an unreadable version must never be the reason a banner
/// appears — or, worse, silently stays away. Two deliberate reliefs from the
/// strict grammar: a core may be shorter than three components (`3.41` reads as
/// `3.41.0`, which is what every hand-written minimum looks like), and leading
/// zeros are tolerated. Build metadata is parsed only far enough to reject the
/// malformed; it never affects precedence.
struct SemanticVersion: Comparable, Sendable {
    /// A dot-separated prerelease identifier. Numeric identifiers rank below
    /// alphanumeric ones and compare as numbers, not as text.
    enum Identifier: Comparable, Sendable {
        case numeric(Int)
        case alphanumeric(String)

        static func < (lhs: Identifier, rhs: Identifier) -> Bool {
            switch (lhs, rhs) {
            case (.numeric(let l), .numeric(let r)): l < r
            case (.numeric, .alphanumeric): true
            case (.alphanumeric, .numeric): false
            case (.alphanumeric(let l), .alphanumeric(let r)): l < r
            }
        }
    }

    let major: Int
    let minor: Int
    let patch: Int
    /// Empty for a release. A non-empty prerelease always ranks *below* the
    /// same core without one.
    let prerelease: [Identifier]

    static func parse(_ value: String) -> SemanticVersion? {
        var rest = Substring(value.trimmingCharacters(in: .whitespaces))

        // Build metadata is ignored for precedence, but `1.0.0+` is malformed
        // and must not read as `1.0.0`.
        if let plus = rest.firstIndex(of: "+") {
            let build = rest[rest.index(after: plus)...]
            guard isValidDotSeparated(build) else { return nil }
            rest = rest[..<plus]
        }

        var prerelease: [Identifier] = []
        if let hyphen = rest.firstIndex(of: "-") {
            let tail = rest[rest.index(after: hyphen)...]
            guard isValidDotSeparated(tail) else { return nil }
            prerelease = tail.split(separator: ".").map { part in
                if part.allSatisfy(\.isNumber), let number = Int(part) {
                    return .numeric(number)
                }
                return .alphanumeric(String(part))
            }
            rest = rest[..<hyphen]
        }

        let parts = rest.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var core = [0, 0, 0]
        for (index, part) in parts.enumerated() {
            guard part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber), let number = Int(part)
            else { return nil }
            core[index] = number
        }
        return SemanticVersion(major: core[0], minor: core[1], patch: core[2],
                               prerelease: prerelease)
    }

    /// Non-empty, and every dot-separated identifier non-empty and made of
    /// ASCII letters, digits or hyphens — the grammar both the prerelease and
    /// the build metadata follow.
    private static func isValidDotSeparated(_ value: Substring) -> Bool {
        guard !value.isEmpty else { return false }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.allSatisfy { part in
            !part.isEmpty && part.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }

    static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
        // A release outranks any prerelease of the same core.
        if lhs.prerelease.isEmpty || rhs.prerelease.isEmpty {
            return !lhs.prerelease.isEmpty && rhs.prerelease.isEmpty
        }
        for (left, right) in zip(lhs.prerelease, rhs.prerelease) where left != right {
            return left < right
        }
        // A shorter run of identifiers is the lower precedence when it is a
        // prefix of the longer one: 1.0.0-alpha < 1.0.0-alpha.1.
        return lhs.prerelease.count < rhs.prerelease.count
    }
}

enum AppVersion {
    /// `nil` when either side is not a version this build can read — "unknown",
    /// which is neither older nor newer. The caller decides what to do with it;
    /// no caller turns it into a banner.
    static func isOlder(_ lhs: String, than rhs: String) -> Bool? {
        guard let left = SemanticVersion.parse(lhs), let right = SemanticVersion.parse(rhs)
        else { return nil }
        return left < right
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
///
/// Version *numbers* on their own are never a banner. The app's
/// `MARKETING_VERSION` and the server's root `package.json` version are
/// separate version lines that differ on every healthy connection; only the
/// server's own `minClient` declaration, and an actual contract mismatch, say
/// anything the operator can act on.
enum BannerPolicy {
    static func kind(
        for state: ConnectionState,
        lastError: ShepherdError?,
        serverName: String,
        serverVersion: String?,
        appVersion: String,
        minClient: String? = nil,
        serverUnhealthy: Bool = false
    ) -> BannerKind? {
        // Two grades of version trouble, most specific first. "Too old" is a
        // statement by the server; a contract mismatch is a symptom, and saying
        // both at once would be noise.
        let tooOld: BannerKind? = {
            guard let minClient else { return nil }
            guard let older = AppVersion.isOlder(appVersion, than: minClient) else {
                Log.connect.debug("ignoring an unreadable version pair for the minimum-client check")
                return nil
            }
            return older ? .clientTooOld(minimum: minClient, app: appVersion) : nil
        }()

        let mismatch: BannerKind? = {
            guard let lastError, case .contractMismatch = lastError, let serverVersion
            else { return nil }
            return .contractMismatch(server: serverVersion, app: appVersion)
        }()

        switch state {
        case .idle, .connecting, .firstRunPending:
            return nil
        case .needsLogin:
            return .needsLogin
        case .live:
            if let tooOld { return tooOld }
            if let mismatch { return mismatch }
            // The socket is up but the server says it is not well. Nothing else
            // in the window would say so.
            return serverUnhealthy ? .offline(server: serverName) : nil
        case .offline:
            // A decode failure against a server we can name a version for is a
            // version problem, not a network problem — say the useful thing.
            if let tooOld { return tooOld }
            if let mismatch { return mismatch }
            return .offline(server: serverName)
        }
    }
}

struct ConnectionBanner: View {
    let kind: BannerKind
    /// Disables Retry while one is already in flight, so a second click cannot
    /// start a second round trip.
    var isRetrying: Bool = false
    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: kind.systemImage)
                .accessibilityHidden(true)
            Text(verbatim: kind.message)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button(L.t("common_retry"), action: onRetry)
                .buttonStyle(.link)
                .disabled(isRetrying)
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
        ConnectionBanner(kind: .contractMismatch(server: "1.47.0", app: "0.1.0")) {}
        ConnectionBanner(kind: .clientTooOld(minimum: "3.42.0", app: "3.41.0")) {}
        ConnectionBanner(kind: .needsLogin, isRetrying: true) {}
    }
    .frame(width: 640)
}
#endif
