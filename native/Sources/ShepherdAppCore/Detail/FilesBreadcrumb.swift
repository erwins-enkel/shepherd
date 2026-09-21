import ShepherdKit
import SwiftUI

/// The cumulative path behind each breadcrumb crumb. The root crumb carries `nil`, which is what
/// `DetailModel.browse(session:source:path:)` sends to list the root.
public enum FilesBreadcrumb {
    public static func trail(_ path: String) -> [(label: String, path: String?)] {
        var trail: [(label: String, path: String?)] = [(label: "", path: nil)]
        var cumulative = ""
        for segment in path.split(separator: "/") where !segment.isEmpty {
            cumulative = cumulative.isEmpty ? String(segment) : "\(cumulative)/\(segment)"
            trail.append((label: String(segment), path: cumulative))
        }
        return trail
    }
}
