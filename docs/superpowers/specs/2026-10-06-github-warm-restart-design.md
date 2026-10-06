# GitHub warm restart (#2826)

Shepherd restarts must preserve GitHub read data without spending the hourly budget
rebuilding unchanged repositories. The existing SQLite store owns a versioned read-cache
table; a shared, injectable cache loads its rows at construction. It is passed to both
forge resolvers, counts and open-PR snapshots. No new dependencies or operator steps.

Persist fingerprints and their observation time, issue lists, counts, open-PR snapshots and closing-issue links,
complete epic structures, issue relations (sub-issues and blockers), and the viewer login.
Maps and sets must survive serialization. Invalid JSON or an incompatible row version is
dropped. Cache keys are the fingerprint's content: issues use `openIssues|issuesUpdatedAt`,
counts use `openIssues|openPrs|prsUpdatedAt|ciState`, PRs use `openPrs|prsUpdatedAt`.
Process-local generations only protect against in-flight writes; never persist them as
freshness keys.

Session PR state already lives in `session_git_cache`. Record a versioned content-key
certificate for each successful read in the shared cache, so a newer saved fingerprint
cannot certify an older session snapshot after a crash. Only certified, unchanged, stable
sessions skip polling; transient sessions still poll. PR writes remove these certificates.

Rehydrated fingerprints cover repositories until the first successful observation of each
repository, including through backoff and reset. An unchanged persisted fingerprint is
not first-seen. A changed key makes the next read fetch fresh data. Entries at least
24 hours old still answer immediately and refresh in the background, single-flight,
above the reserve. Failed refreshes keep the last good value.

Own writes delete the affected disk and memory rows, including counts and PR snapshots.
Invalidation is shared across forge instances and prevents an older in-flight read from
repopulating persistence. Incomplete epic fallback data is never persisted as complete.

Boot's fingerprint runs before Up Next and broad background scans. Those scans run only
after a successful fingerprint and with at least 1,000 GraphQL points remaining (or after
the reading's reset). PR polls needed for transient sessions remain permitted.
Operator-requested and post-start Up Next recomputes bypass this background gate so claimed
items disappear immediately. Failed GitHub count reads have a 30-second process-local
negative entry; own writes or a changed content key bypass it.

Verify with injected clocks/stores and restart simulations: unchanged repositories make
no issue-list, counts or relation calls for five minutes; restart in backoff produces no
second wave after reset; changes while down refresh only affected repositories; own writes
invalidate across restart and cannot be undone by a late fetch; old and corrupt rows are
handled safely. Run root lint and the complete root test suite before delivery.
