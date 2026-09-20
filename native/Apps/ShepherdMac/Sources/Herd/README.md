# Herd row integration

Install `HerdStream` after `SidebarInstall`, `NotificationsStream`, and
`SessionSignals.connect(app)`; the latter still assigns S2's sparse git cache.
The integration lane owns this registration and the per-activation S8/S12 bindings.

The sidebar samples its partition every twenty seconds, like the row's display clock,
so final-review and merge deadlines expire even without a server frame. This only
recomputes presentation; it does not poll any route.

`HerdSignals` observes the session list independently of its five snapshot reads.
An empty list is unknown until bootstrap, then authoritative even when all herd reads
fail. Reconciliation removals overlay in-flight reads, and late frames for removed ids
are pruned. Teardown finishes both observation streams and cancels the event tap.

`HerdRowSignals.presentation` is the row's production presentation path. Its critic flag
comes only from `HerdSignals.isReviewing`. `HerdStream` separately combines critic and plan
review for `SidebarModel.inReview`, including Ready-lens exclusion.

Repository autopilot inheritance has a missing native source. The web reads
`RepoConfigResponse.autopilotEnabled` from `GET /api/repo-config?repo=<repoPath>` in
`reviews.svelte.ts`, then passes `repoConfig.isAutopilotEnabled(session.repoPath)` to
`UnitRowRight`'s autopilot badge. Neither that route nor its response schema exists in this
branch's native contract. `SessionStore.repos` comes from `GET /api/repos`; the server's
`handleRepos` returns repository metadata, usage counts, forge identity and visibility,
not `autopilotEnabled`. It is also not a repository default on the Session wire payload.

The route belongs to S12 (master milestone plan, settings contract block). When that model
lands, S0 integration must bind `HerdSignals.repoAutopilotDefault` to its observable lookup
by session repository path on every activation. Until then the seam returns `nil` for
unknown configuration. The row forwards that optional value explicitly: a session's
`autopilotEnabled` wins, including an explicit `false`; otherwise a known repository
default is inherited. Tests exercise this production path with an enabled repository and
missing Codex identifiers. No new request or guessed repository field is introduced here.

Row tint mapping follows web roles using native colors: amber progress/caution is orange,
comments are blue, approval/ready is green, failure/stall is red, slate is secondary, and
faint terminal/error labels use secondary at reduced opacity. These are independent of
`SessionStatusStyle.running`, whose green is unsuitable for pending/reviewing/merging.
