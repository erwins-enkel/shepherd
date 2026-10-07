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

**Browser View**:
The operator's live, interactive picture of the Shared Browser inside the HUD.
_Avoid_: screencast, remote desktop, VNC
