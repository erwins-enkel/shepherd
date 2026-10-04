import Foundation
import ShepherdKit

/// Which repos the composer offers first. Mirrors the web composer's `defaultRepoPath`:
/// the repo a task was last started in wins. `Repo.lastUsedAt` arrives once with the
/// bootstrap, so the sessions the store holds cover tasks started since.
/// Callers pass the visible repos; nothing here filters hidden ones.
public enum RepoRecency {
    public static let recentLimit = 5

    /// Repo path → newest task start (ms epoch). Sessions of unlisted repos are ignored.
    public static func lastUsed(_ repos: [Repo], sessions: [Session]) -> [String: Int] {
        var stamps: [String: Int] = [:]
        for repo in repos { if let used = repo.lastUsedAt { stamps[repo.path] = used } }
        let listed = Set(repos.map(\.path))
        for session in sessions where listed.contains(session.repoPath) {
            stamps[session.repoPath] = max(stamps[session.repoPath] ?? session.createdAt, session.createdAt)
        }
        return stamps
    }

    /// Repos with a task start, newest first; ties by name.
    public static func recent(_ repos: [Repo], sessions: [Session], limit: Int = recentLimit) -> [Repo] {
        let stamps = lastUsed(repos, sessions: sessions)
        let used = repos.compactMap { repo in stamps[repo.path].map { (repo, $0) } }
        let ranked = used.sorted { a, b in a.1 != b.1 ? a.1 > b.1 : precedes(a.0, b.0) }
        return ranked.prefix(limit).map { $0.0 }
    }

    public static func alphabetical(_ repos: [Repo]) -> [Repo] { repos.sorted(by: precedes) }

    /// The composer's preselection: the most recently used repo, else the first listed.
    public static func defaultPath(_ repos: [Repo], sessions: [Session]) -> String? {
        recent(repos, sessions: sessions, limit: 1).first?.path ?? repos.first?.path
    }

    /// "12 minutes ago" / "vor 12 Minuten" for a ms-epoch task start.
    public static func age(_ ms: Int, now: Date = .now, locale: Locale = .current) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .named
        formatter.locale = locale
        return formatter.localizedString(for: Date(timeIntervalSince1970: Double(ms) / 1_000), relativeTo: now)
    }

    private static func precedes(_ a: Repo, _ b: Repo) -> Bool {
        a.name.localizedStandardCompare(b.name) == .orderedAscending
    }
}
