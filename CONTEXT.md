# Shepherd

Mission control for interactive coding-agent sessions: an operator spawns, steers and reviews agents working on their repos.

## Language

### Shared browser

**Shared Browser**:
A real, headful Chrome running on the Shepherd host, one per repo, that the operator and that repo's agents drive together.
_Avoid_: agent browser, test browser, remote browser

**Browser Profile**:
The persistent per-repo state (cookies, storage, logins) behind a Shared Browser; survives sessions until the operator resets it.
_Avoid_: storage state, cookie jar, session (overloaded)

**Handoff Login**:
The operator signing in to any service inside the Shared Browser so an agent can continue as that logged-in user.
_Avoid_: auth import, credential sharing

**Login Request**:
An agent's ask that the operator perform a Handoff Login at a given URL; it waits as a needs-you item until the operator marks it done.
_Avoid_: auth prompt, login steer

**Browser Attach**:
A session's scoped, revocable right to drive its repo's Shared Browser, granted and brokered by Shepherd.
_Avoid_: CDP connection, debug port

**Browser Origin Allowlist**:
The per-repo hosts an autonomous session's Browser Attach may reach, plus that session's own Preview origin; everything else is refused.
_Avoid_: browser egress list, allowed origins

**Confined Attach**:
An autonomous session's Browser Attach, limited to its own browser context behind the Browser Origin Allowlist and seeded only with logins for allowed hosts.
_Avoid_: sandboxed browser, restricted attach

**Browser View**:
The operator's live, interactive picture of the Shared Browser inside the HUD.
_Avoid_: screencast, remote desktop, VNC

### Task submission

**Dispatch**:
One task submission sent with an `Idempotency-Key`, accepted at most once; its outcome (pending, started, held, failed) survives restarts and is read back by that key.
_Avoid_: job, order, request (overloaded)

**Remote Dispatch**:
A new task this Shepherd sends to a connected machine to run there: stored here before it is sent, delivered under its own dispatch ID, and only ever sent again to that same machine. Its attachments are uploaded to that machine just before it is sent, once. When no answer comes back its start status is unknown — not failed — until this Shepherd has asked the machine what became of it; until the machine confirms it, it can be canceled.
_Avoid_: forward, relay, remote job

**Waiting Task**:
A remote dispatch the placement meant for a machine that is out of reach or lacks a requirement right now: stored here, nothing sent, and sent to that machine by itself once it is back and a fresh check passes. It never moves to another machine on its own; the operator can cancel it or redirect it to another machine that fits. Distinct from a task held on a machine, which that machine has already accepted.
_Avoid_: queued task, pending dispatch

**Placement**:
Where a new task runs and why, chosen once when it is submitted: the machine — this Shepherd or a connected one — and the reason (its requirements, the platform order, the only candidate, or the operator's choice). Recorded on the session; it never moves the task afterwards and never falls back to another machine on its own — a task meant for a machine out of reach waits for it.
_Avoid_: routing, scheduling, load balancing

**Requirement**:
A capability a task needs from the machine it runs on (Xcode, an SDK, an agent CLI, a sandbox profile, a platform); the placement only picks a machine whose verified capabilities include every one. Given by the operator, or read from the task's prompt and issue (never the repository) while the machines differ in it.
_Avoid_: constraint, tag, label

**Base Commit**:
The commit a session's worktree was actually created from; an explicitly requested one is used as-is, never freshened to the branch tip.
_Avoid_: base sha, start commit
