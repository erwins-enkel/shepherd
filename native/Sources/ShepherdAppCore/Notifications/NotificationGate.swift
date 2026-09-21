import Foundation

/// Whether an intent may be shown right now.
///
/// Three rules, all ported from `PushService.notify` in `src/push.ts`:
///  - **focus**: `if (this.isActive()) return false;`. The web suppresses while any tab is
///    focused and visible; here it is this app's own window. The live list already says
///    everything a banner would.
///  - **settings**: the per-device category filter. The web exempts `ready` from it
///    (`if (input.kind !== "ready" && !row.cats[category]) continue;`), and this port does
///    **not** — see `NotificationKind.category` for why: the web's `ready` push only ever fires
///    in reduced-push mode, where the category toggles are already bypassed wholesale, while
///    this port fires `ready` off the operator's own manual ready-to-merge toggle. Nothing
///    walks past a muted category here.
///  - **cooldown**: `withinCooldown(key, t, cooldownMs)` with the same 120 s default. The clock
///    is started by `posted(_:at:)`, which the caller calls only when the banner really reached
///    the notification centre — the port of
///    `if (sent && cooldownMs > 0) this.lastNotified.set(key, t)`.
///
/// Two calls, not one, because delivery can fail: `notificationd` rejects `add(_:)` often enough
/// that stamping on the *allowed* branch would let one rejected banner swallow the next 120 s of
/// that session and kind — the agent stays blocked and the operator is never told, where the web
/// delivers on the retry. Nothing is lost by waiting: `NotificationsModel.subscribe` drives
/// `handle(_:)` from a strictly serial `for await` loop, so frame N+1 cannot even start until
/// `handle(N)` has returned and stamped.
struct NotificationGate {
    /// `SHEPHERD_PUSH_COOLDOWN_MS`'s default in `src/config.ts`, in milliseconds.
    static let defaultCooldown = 120_000

    private let cooldown: Int
    /// Cooldown key -> the timestamp of the last notification actually delivered under it.
    private var lastPosted: [String: Int] = [:]

    init(cooldown: Int = NotificationGate.defaultCooldown) {
        self.cooldown = cooldown
    }

    /// Non-mutating on purpose: asking does not start the clock. The caller must follow a `true`
    /// with `posted(_:at:)` — and only on the branch where the post really went out.
    func allows(
        _ intent: NotificationIntent,
        at now: Int,
        settings: NotificationSettings,
        windowFocused: Bool,
        authorized: Bool
    ) -> Bool {
        guard authorized, !windowFocused, settings.enabled else { return false }
        // `settings.enabled && row.cats[category]`, spelled out: the master switch is already
        // checked above, so what is left is the per-category filter.
        guard settings.isOn(intent.kind.category) else { return false }
        if cooldown > 0, let last = lastPosted[intent.cooldownKey], now - last < cooldown {
            return false
        }
        return true
    }

    /// Starts the 120 s window for this intent's key. `if (sent && cooldownMs > 0)` in
    /// `PushService.notify` — pass the same `now` that `allows` was asked with, which is what the
    /// web does (it stamps the `t` it sampled before delivery).
    mutating func posted(_ intent: NotificationIntent, at now: Int) {
        guard cooldown > 0 else { return }
        lastPosted[intent.cooldownKey] = now
    }
}
