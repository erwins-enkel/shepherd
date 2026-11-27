import Foundation
import ShepherdKit

/// `ui/src/lib/components/viewport/artifact-row.ts` and `shared/artifact-url.ts`: which artifact
/// a session shows and where. The iOS artifact card and the merge card's artifact row (#3878)
/// render these.
public enum ArtifactRowRules {
    public enum Surface: Equatable, Sendable {
        case none
        /// Without a merge card: the artifact card takes its place.
        case card(SessionArtifact)
        /// With a merge card: a row inside it.
        case mergeRow(SessionArtifact)
    }

    /// `isArtifactUrl`: `https://claude.ai/artifact/<id>` or `https://claude.ai/code/artifact/<id>`
    /// exactly. Anything else is never opened.
    public static func url(_ artifact: SessionArtifact) -> URL? {
        guard artifact.url.wholeMatch(of: #/https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9_-]{1,64}/#) != nil else { return nil }
        return URL(string: artifact.url)
    }

    /// `latestArtifact`: the most recently published artifact with a valid link; a later entry
    /// wins a tie. Nil without one, or once the operator hid them all (#3877) — a new url
    /// arrives without `hiddenAt` and shows it again.
    public static func latest(_ artifacts: [SessionArtifact]?) -> SessionArtifact? {
        let shown = (artifacts ?? []).filter { url($0) != nil }
        guard shown.contains(where: { $0.hiddenAt == nil }) else { return nil }
        return shown.enumerated().max { ($0.element.updatedAt, $0.offset) < ($1.element.updatedAt, $1.offset) }?.element
    }

    /// The merge card wins; the artifact card shows only without it.
    public static func surface(_ artifacts: [SessionArtifact]?, mergeCard: Bool) -> Surface {
        guard let artifact = latest(artifacts) else { return .none }
        return mergeCard ? .mergeRow(artifact) : .card(artifact)
    }

    /// "Fassung 3 · vor 5 Min."
    public static func facts(_ artifact: SessionArtifact, now: Date = Date()) -> String {
        L.t("artifactrow_menu_facts", String(artifact.versions), when(artifact, now: now))
    }

    /// VoiceOver: the title, then version and age.
    public static func accessibilityLabel(_ artifact: SessionArtifact, now: Date = Date()) -> String {
        L.t("prrow_artifact_aria", artifact.title) + ", "
            + L.t("prrow_artifact_tip_status", String(artifact.versions), when(artifact, now: now))
    }

    private static func when(_ artifact: SessionArtifact, now: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        let updated = Date(timeIntervalSince1970: Double(artifact.updatedAt) / 1_000)
        return formatter.localizedString(for: min(updated, now), relativeTo: now)
    }
}
