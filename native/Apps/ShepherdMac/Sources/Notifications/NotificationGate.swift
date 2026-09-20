import Foundation

/// Whether an intent may be shown right now.
///
/// Three rules, all ported from `PushService.notify` in `src/push.ts`:
///  - **focus**: `if (this.isActive()) return false;`. The web suppresses while any tab is
///    focused and visible; here it is this app's own window. The live list already says
///    everything a banner would.
///  - **settings**: the per-device category filter, with `ready` bypassing it exactly as the web
///    does (`if (input.kind !== "ready" && !row.cats[category]) continue;`) — except that the
///    profile's master switch overrides even that, because an operator who turned a server off
///    did not mean "except sometimes".
///  - **cooldown**: `withinCooldown(key, t, cooldownMs)` with the same 120 s default and the same
///    "only a send starts the clock" rule. A notification nobody saw must not swallow the next.
struct NotificationGate {
    /// `SHEPHERD_PUSH_COOLDOWN_MS`'s default in `src/config.ts`, in milliseconds.
    static let defaultCooldown = 120_000

    private let cooldown: Int
    /// Cooldown key -> the timestamp of the last notification actually posted under it.
    private var lastPosted: [String: Int] = [:]

    init(cooldown: Int = NotificationGate.defaultCooldown) {
        self.cooldown = cooldown
    }

    /// Mutating: a positive answer stamps the cooldown clock **before** the caller's `await`, so
    /// the caller must post whatever this returns true for.
    ///
    /// The optimistic stamp is load-bearing. The web has an `inFlight` flag that serialises two
    /// frames arriving back to back while a post is still resolving; this port does not
    /// reproduce it, and `NotificationTrigger` no longer guards repeats either. Stamping here,
    /// synchronously, is the only thing that keeps two `session:status` frames one millisecond
    /// apart from both getting past the cooldown. Do not "improve" this into a
    /// post-confirmation stamp.
    mutating func allows(
        _ intent: NotificationIntent,
        at now: Int,
        settings: NotificationSettings,
        windowFocused: Bool,
        authorized: Bool
    ) -> Bool {
        guard authorized, !windowFocused, settings.enabled else { return false }
        // `settings.enabled && (bypass || settings.allows(category))`, spelled out: the master
        // switch is already checked above, so what is left is the category filter that `ready`
        // walks past.
        if !intent.kind.bypassesCategoryFilter, !settings.isOn(intent.kind.category) {
            return false
        }
        if cooldown > 0, let last = lastPosted[intent.cooldownKey], now - last < cooldown {
            return false
        }
        lastPosted[intent.cooldownKey] = now
        return true
    }
}
