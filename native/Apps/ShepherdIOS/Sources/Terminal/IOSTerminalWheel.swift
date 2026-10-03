import CoreGraphics
import Foundation

/// Turns finger travel over the terminal into whole mouse-wheel lines, keeping the
/// remainder like SwiftTerm's Mac trackpad accumulator. A released flick coasts with
/// the web terminal's fling constants (`Viewport.svelte`).
/// Positive lines reveal older output: the finger moves down, the wheel turns up.
struct IOSTerminalWheel {
    /// Below this a coast has effectively stopped, in points per second.
    static let minimumVelocity: CGFloat = 30
    /// Clamps a freak release reading so a flick cannot rocket.
    static let maximumVelocity: CGFloat = 6000
    /// Velocity retained per 16 ms frame.
    static let decayPerFrame: CGFloat = 0.96

    let lineHeight: CGFloat
    private(set) var velocity: CGFloat = 0
    private var remainder: CGFloat = 0

    init(lineHeight: CGFloat) { self.lineHeight = max(1, lineHeight) }

    /// The finger moved `dy` points (positive is down); returns whole lines to send.
    mutating func drag(by dy: CGFloat) -> Int {
        remainder += dy
        let lines = Int(remainder / lineHeight)
        remainder -= CGFloat(lines) * lineHeight
        return lines
    }

    /// The finger lifted at `velocity` points per second; a slow release does not coast.
    mutating func release(velocity: CGFloat) {
        let clamped = min(Self.maximumVelocity, max(-Self.maximumVelocity, velocity))
        self.velocity = abs(clamped) < Self.minimumVelocity ? 0 : clamped
    }

    /// Advances the coast by `dt` seconds; nil once it has stopped.
    mutating func coast(dt: TimeInterval) -> Int? {
        guard velocity != 0 else { return nil }
        velocity *= pow(Self.decayPerFrame, CGFloat(dt / 0.016))
        guard abs(velocity) >= Self.minimumVelocity else {
            stop()
            return nil
        }
        return drag(by: velocity * CGFloat(dt))
    }

    mutating func stop() {
        velocity = 0
        remainder = 0
    }
}
