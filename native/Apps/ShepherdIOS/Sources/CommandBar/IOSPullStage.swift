import Foundation

/// Native scroll geometry is already rubber-banded; use points without a second resistance curve.
enum IOSPullStage: Equatable {
    case idle, search, reload

    init(distance: CGFloat) {
        self = distance >= 144 ? .reload : distance >= 64 ? .search : .idle
    }
    var labelKey: StaticString {
        switch self {
        case .idle: "mobile_pull_search"
        case .search: "mobile_release_search"
        case .reload: "mobile_release_reload"
        }
    }
}

/// Retain the maximum only during direct interaction, so bounce/deceleration cannot arm a pull.
struct IOSCommandBarPull {
    private(set) var distance: CGFloat = 0
    private(set) var maximum: CGFloat = 0
    private(set) var interacting = false
    var stage: IOSPullStage { IOSPullStage(distance: maximum) }
    mutating func begin(distance: CGFloat) {
        interacting = true; maximum = 0; update(distance: distance)
    }
    mutating func update(distance: CGFloat) {
        self.distance = max(0, distance)
        if interacting { maximum = max(maximum, self.distance) }
    }
    mutating func release() -> IOSPullStage {
        let result = stage
        self = Self()
        return result
    }
}
