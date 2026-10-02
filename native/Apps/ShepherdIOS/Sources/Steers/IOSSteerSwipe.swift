import CoreGraphics
import Observation
import SwiftUI
import UIKit

/// A sideways swipe across the terminal output: right goes back to the overview,
/// left opens the steers. Pure, so thresholds are testable without a touch.
struct IOSSteerSwipe: Equatable {
    enum Outcome: Equatable { case none, openSteers, back }

    /// Past this distance a release commits; a fast flick commits earlier.
    static let threshold: CGFloat = 90
    static let flickVelocity: CGFloat = 700
    static let flickMinimum: CGFloat = 30
    /// Beyond this the content follows the finger with resistance.
    static let softLimit: CGFloat = 140

    private(set) var offset: CGFloat = 0
    private(set) var armed = false

    mutating func update(_ pan: IOSHorizontalPan, allowsBack: Bool, allowsSteers: Bool) -> Outcome {
        switch pan {
        case .changed(let dx):
            let allowed = dx < 0 ? allowsSteers : allowsBack
            guard allowed, dx != 0 else { offset = 0; armed = false; return .none }
            offset = Self.resisted(dx)
            armed = abs(dx) >= Self.threshold
            return .none
        case .ended(let dx, let velocity):
            defer { offset = 0; armed = false }
            let flick = abs(velocity) >= Self.flickVelocity && abs(dx) >= Self.flickMinimum
                && (velocity < 0) == (dx < 0)
            guard abs(dx) >= Self.threshold || flick else { return .none }
            if dx < 0 { return allowsSteers ? .openSteers : .none }
            return allowsBack ? .back : .none
        case .cancelled:
            offset = 0
            armed = false
            return .none
        }
    }

    static func resisted(_ dx: CGFloat) -> CGFloat {
        let magnitude = abs(dx)
        guard magnitude > softLimit else { return dx }
        let damped = softLimit + (magnitude - softLimit) * 0.35
        return dx < 0 ? -damped : damped
    }
}

/// Owns the swipe and the panel for one detail, so the terminal's UIKit pan can
/// report into it without capturing the SwiftUI view.
@MainActor
@Observable
final class IOSSteerGestureState {
    private(set) var swipe = IOSSteerSwipe()
    private(set) var steersOpen = false
    @ObservationIgnored var allowsBack = true
    @ObservationIgnored var allowsSteers = true
    @ObservationIgnored var back: () -> Void = {}

    func handle(_ pan: IOSHorizontalPan) {
        let wasArmed = swipe.armed
        var next = swipe
        let outcome = next.update(pan, allowsBack: allowsBack, allowsSteers: allowsSteers)
        if case .changed = pan { swipe = next }
        else { withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { swipe = next } }
        if next.armed, !wasArmed { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
        switch outcome {
        case .none: break
        case .openSteers: setSteersOpen(true)
        case .back: back()
        }
    }

    func setSteersOpen(_ open: Bool) {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) { steersOpen = open }
    }
}
