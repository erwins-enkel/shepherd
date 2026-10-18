# iOS terminal outage recovery

The terminal reply dock becomes a reconnect panel while its owning server cannot
be reached. `IOSTerminalConnection.isUnreachable` is the single outage policy:
hub unavailability (including its eight-second connecting deadline), an offline
store, a transport error, an ended-unreachable PTY, or a server-stalled latency
verdict. It uses the session's `AppModel`, never the hub's focused server.

A stalled event loop can belong to a slow but reachable server. It still locks
input because this is the operator's reported failure. `LatencyReport` calls it
stalled only once one of this device's own requests in the 60-second lag window
waited at least a second, so a stall the device never felt neither locks input nor
turns the header red. Retry uses that server's
existing `app.retry()`, confirms a fresh response for the terminal's own session,
and calls `takeOver()` only for an ended-unreachable terminal. Input stays locked
until the outage predicate clears and a recovering attachment finishes connecting.
The fresh response acknowledges the current stall episode: `Server-Timing` lag
covers the preceding minute and may remain high after successful recovery. The
header keeps its existing latency report. Once the report leaves server-stalled,
a later stall locks input again. Failed probes never acknowledge a stall.

`IOSReconnectState` owns the offline/checking/failed/connected states, the
30-second retry deadline, and the three-second recovery badge. Its clock, sleep
and async reconnect operation are injectable. Failed and manual checks restart
the deadline. View disappearance and inactive scenes cancel the countdown and
invalidate in-flight results; foreground entry retries immediately. `AppModel`
continues to own and cancel its own retry request across activation changes.

The presentation guards reply, steer and terminal-key sends, removes the prompt
target, and closes writing and dictation. Cancelling dictation preserves the
current model draft, including already committed dictation checkpoints. No command
is queued or automatically sent after recovery. Terminal output remains visible
at 45% opacity with its last-contact badge. Gone/resume and superseded recovery
keep their previous behaviour.

The new card reuses the existing terminal/session palette, monospaced Dynamic
Type, and native EN/DE catalog generator. The main action is at least 52 points
high. Accessibility text stacks vertically; the output retains 160 points while
the card scrolls, allowing every action and sentence to remain reachable. The
countdown stays readable by VoiceOver with `updatesFrequently`, with no live
announcement each second. The recovery capsule uses no animation at any motion
setting, so Reduce Motion requires no separate animated path.

`IOSReconnectTests` drives virtual time, cancellation, draft retention, the outage
policy, the actual server retry/session confirmation/PTY reattachment path, and
hosted ImageRenderer fixtures. Hosting is needed because ImageRenderer alone does
not paint UIKit spinner and scroll surfaces. Fixtures do not capture a simulator
screen or require a live server.

Mobile web reference: `ViewportTermControls.svelte` and `SteerBar.svelte` provide
the existing input hierarchy and terminal palette. This panel and its countdown
are iOS additions; no web or Mac behaviour changes.
