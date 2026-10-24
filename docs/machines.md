# Run tasks on another machine

Connect another Shepherd to yours as a **machine**, for example the one on your MacBook, and you
can start a task there from your usual Shepherd. The whole session runs on that machine: the
worktree, herdr, the agent, builds and tests. The Shepherd you started it from shows it in its herd
and lets you steer it. Typical setup: a Linux server you work from (the **coordinator**) and a
MacBook with Xcode that takes macOS and iOS tasks.

Shepherd picks the machine for each task by what it needs: a task that needs Xcode goes to the
MacBook, any other to Linux. You can always name the machine yourself. A running session never
moves to another machine.

## How it works

- **A machine is another Shepherd.** You connect it with its address and an access token created
  on it. Each side connects the other on its own; connecting in both directions is fine.
- **Sessions stay where they run.** A machine keeps running its own sessions, including those
  started there directly or by its own automation. Your Shepherd shows them in its herd, among its
  own sessions in the lifecycle group their state belongs to, labelled with the machine they run
  on (`MacBook · TASK-07`), and never treats them as its own: no poller, autopilot, merge train,
  drain or reaper on your side touches them. A session on another machine is never passed on, so
  two machines connected to each other neither loop nor show a session twice. A repo filter in the
  herd also keeps the other machines' sessions of the same project, matched by its forge remote
  (`owner/repo`), because the checkout paths differ between machines.
- **Actions go to the machine.** The terminal, steering, stopping, archiving, the diff, the files
  and the preview are sent to the machine and run there. While the machine can't be reached,
  nothing is sent and nothing runs on your side in its place.
- **A new task is handed over once.** It goes out with a dispatch ID, so sending it again never
  starts it twice there, even after a lost answer or a restart.
- **A task waits for its machine.** If the machine a task is meant for is asleep or out of reach,
  the task waits on your Shepherd and starts there once the machine is back. It never starts on
  another machine by itself ([Waiting tasks](#waiting-tasks)).

## macOS session controls

Use the same compatible Shepherd release on the coordinator and the connected machine. The Mac
app displays the same context menu, action bar and Terminal, Activity, Diff, Files, PR, Plan, Merge
and Prompt tabs for both. Rename, resume, relaunch, variant, replacement, clean terminal, reviews,
queue changes and archive execute on the session's machine. Closing still asks for confirmation
and lets you choose which leftover processes to stop.

Saved steering templates belong to the server selected in the app: when connected to Mo, both
Mo and MacBook sessions use and edit Mo's templates. Sending a chip or its keyboard shortcut goes
to the selected session's machine. Repository scopes match projects by their forge slug even if
the checkout paths differ. Global merge and drain dashboards remain those of the selected server.

While a machine is disconnected, its tabs and last known data remain visible. Session actions
are disabled, while editing the selected server's steering templates stays available. Reconnection
refreshes snapshots and reattaches the terminal. A failed snapshot read retains the previous data
with a stale-data notice.

To verify with two disposable sessions, select the local session, right-click the machine's card
and rename it. Open all eight tabs, send a template by chip and by ⌘1, then cancel and confirm the
close dialog. Check the machine received the mutations and the coordinator's session is unchanged.
Disconnect and reconnect the machine before closing; the controls should disable and recover
without selecting the session again. The automated fixture is
`test/fixtures/remote-session-parity-ui-server.ts` with
`native/Apps/ShepherdMac/UITests/RemoteSessionParityUITests.swift`.

## Prepare each machine

Each machine needs everything its sessions use, under the user Shepherd runs as:

| Requirement      | What it means                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same Shepherd    | Both run the same release, so they speak the same machine interface. A mismatch shows as **Incompatible**. To try changes that aren't released yet, run the same branch on both ([below](#test-a-branch-on-two-machines)).                                                                                                                                                                |
| herdr            | The herdr version Shepherd supports ([install](getting-started.md)). A newer herdr breaks agent spawning on that machine.                                                                                                                                                                                                                                                                 |
| Agent login      | `claude` (and `codex`, if you use it) installed and logged in on that machine. Its sessions use that login and its usage limits: a task over the limits is held there.                                                                                                                                                                                                                    |
| Project checkout | The project checked out on the machine, with the same forge remote (`owner/repo`). That slug is how a project is matched; the path may differ. Shepherd doesn't clone for you.                                                                                                                                                                                                            |
| Xcode (Mac)      | Full Xcode (not only the Command Line Tools), its license accepted, and the SDKs and simulators the work needs. Set up the [UI Automation mode](../native/docs/development.md#ui-automation-mode) and [package resolution without Keychain prompts](../native/docs/development.md#package-resolution-without-keychain-prompts) once, so an unattended run never waits on a system dialog. |

**Settings → Machines** on the coordinator shows each machine's checked **capabilities**: Xcode,
the macOS and iOS SDKs, an iOS simulator, the agent logins and the sandbox profiles. The machine
checks them every five minutes and again when it accepts a task that names
[`requirements`](external-task-api.md).

## Make it reachable in your tailnet

The coordinator's server must reach the machine's server. Shepherd keeps listening on loopback
only; Tailscale serves it over HTTPS at the machine's tailnet name.

- **Linux:** `tailscale serve --bg 7330` serves it at `https://<host>.<tailnet>.ts.net`.
- **Mac app:** turn on **Reachable in your tailnet** in the local server panel. It shows the URL to
  use ([details](../native/docs/getting-started.md#reach-the-local-server-from-your-tailnet)).

Check from the coordinator's host:

```bash
curl -s https://<machine>.<tailnet>.ts.net/api/health                                  # answers
curl -s -o /dev/null -w '%{http_code}\n' https://<machine>.<tailnet>.ts.net/api/sessions  # 401
```

Server-to-server requests send no browser origin, so `SHEPHERD_ALLOWED_HOSTS` needs no entry for
this.

## Create a token on the machine

On the **machine**, open **Settings → Access** and create a token with scope **Full** and access to
**all repositories**. Pick any expiry. The value is shown once. (The `SHEPHERD_TOKEN` environment
variable also works; it is always unrestricted.)

## Connect it

On the **coordinator**, open **Settings → Machines → Connect a machine** and enter the machine's
address (its `https://` URL, without credentials, query or fragment), the token and, optionally, a
name. Only an operator signed in to the coordinator can connect a machine; an access token can't.

Shepherd checks the machine at once and every minute after:

| Status             | Meaning and next step                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connected          | It answers, accepts the token and speaks the same interface. Its version, platform, projects and capabilities are shown.                                                |
| Unreachable        | No answer within 5 seconds, no connection, a redirect (enter the final `https://` address) or something that isn't a Shepherd. Check the address and that it's running. |
| Not authorized     | The token was rejected (revoked, expired, incomplete), isn't scope Full, or is limited to some repositories. Create a new one, remove the machine and connect it again. |
| Incompatible       | That Shepherd is too old or speaks another version of the machine interface. Update both to the same release.                                                           |
| Different instance | Another Shepherd now answers at this address. If that's intended, remove the machine and connect it again.                                                              |

To work the other way round too, connect the coordinator on the machine with a token from the
coordinator. **Settings → Machines** shows which directions are connected
([below](#see-both-directions)).

## See both directions

Each side connects the other on its own, so connecting only one direction is easy to miss: if
only the MacBook connects the coordinator, the MacBook's herd shows the coordinator's sessions,
but the coordinator shows none of the MacBook's. **Settings → Machines** shows both directions:

- **You see their sessions** lists the machines connected here. Each row says how many of its
  sessions are in your herd, whether it takes tasks (connected, on a released platform), and
  whether it **sees yours too**.
- **They see your sessions** lists the Shepherds that connected this one and are directly
  connected to it right now, each with the access token it uses here and since when. An entry ends
  when its connection does.

| Direction          | Meaning and next step                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both directions    | That Shepherd is also connected here, and this Shepherd's own check confirmed it is the same instance.                                                                                                                     |
| One direction only | It sees your sessions, you don't see its sessions. **Connect … here** opens the connect form with its name; add its address and a token from it. If it is connected here but its check fails, its status is named instead. |
| Direction unknown  | It sends no instance ID, so it runs an older release. Update both to the same release.                                                                                                                                     |

A Shepherd that shows your sessions names itself in two headers on its live connection
(`/events?host=local`) and its session request: `X-Shepherd-Instance-Id` and
`X-Shepherd-Instance-Name` (percent-encoded). What it claims there is shown, never trusted: the
name is shortened and cleaned, nothing of it is logged, and **Both directions** rests on this
Shepherd's own check of a machine with that ID. Only an operator signed in here sees the list.

## Start a task on a machine

In **New Task**, **Run on** starts on **Automatic**: Shepherd chooses the machine (see
[Automatic choice](#automatic-choice)) and shows which one and why before you start, for example
"Runs on MacBook — Needs Xcode". To choose yourself, pick **This machine** or a connected machine
that has the project checked out and runs a platform released for tasks (Linux, macOS). A machine
you pick must have what the task needs, or nothing starts and the dialog says what is missing.

- The machine starts from the base branch **as pushed to origin**. Push first.
- Attachments are uploaded to the machine right before the task is sent. If one can't be sent, the
  task doesn't start.
- A refusal on the machine is shown with its reason. A task the machine holds (its usage limit
  or capacity) shows as **Busy** at the top of the herd until it starts there.
- If no answer comes back, the task shows as **Start status unknown** at the top of the herd. Shepherd asks the machine as soon as it can be reached, also after a restart of your
  Shepherd, and then about once a minute. It then shows the session, or sends the same task again
  if it never arrived. It never starts twice and never goes elsewhere. Until the machine confirms
  it, you can cancel it.

From a script, leave `target` out for the automatic choice, or send `target: { instanceId }` to
name the machine, with the create request and an `Idempotency-Key`
([External Task API](external-task-api.md)).

**In the native apps.** New Task in Shepherd for Mac and on iOS has the same **Run on**,
requirement chips, reason and question, and the server chooses by the same rules: on
**Automatic** the app sends no machine. The Mac herd shows waiting, blocked, busy and
start-unknown tasks in the machine's group, with **Run on …** and **Cancel**. The iOS app with
several servers submits through the one it is on: **Run on** lists that server's machines, and any
other connected server it does not reach as a machine moves the task there.

## Automatic choice

A task names what it needs as **requirements**: the chips under the prompt in New Task, or
`requirements` in the API, from the capabilities each machine verifies (Xcode, the iOS and Android
SDKs, the agent CLIs, the sandbox profiles, the platform). Shepherd then:

1. Considers this Shepherd and every connected machine that runs a released platform, has the
   project checked out, and whose capability check, not older than 15 minutes, has every
   requirement.
2. Prefers Linux over macOS, because Linux has the full sandbox and runs all the time. Among
   machines of the same platform the machine ID decides, so the choice is stable.
3. Starts the task on the first one, right away, without asking.

The reason is shown before you start and on the session afterwards: "Needs macOS and Xcode",
"No special requirements – preferred: Linux", "Chosen manually".

- **Wherever you submit.** Every Shepherd with connected machines chooses by the same rules. A web
  task without requirements submitted on the MacBook runs on Linux; an Xcode task submitted on Linux
  runs on the MacBook. This needs both Shepherds connected to each other and using the same platform
  order. Each Shepherd keeps its own order under **Settings → Machines → Automatic choice**, and
  the setting says so.
- **Nothing fits.** If no connected machine has a requirement, nothing starts and Shepherd names what
  is missing, for example "No connected machine has Xcode".
- **The right machine is offline.** If the machine a task is meant for is asleep or out of reach,
  the task waits for it ([Waiting tasks](#waiting-tasks)). New Task says so before you start, for
  example "Waits for MacBook — Needs Xcode", and names the machines that would fit now. It never
  falls back to another machine on its own. Pick one under **Run on** to start it there instead.
- **Read from the task.** Under **Automatic**, New Task reads whether a task needs Xcode, the iOS
  SDK, the iOS simulator or the Android SDK from its prompt, attached issue and attached
  screenshots, a second after you stop typing. The repository is never read, so a `native/` folder
  or a `Package.swift` alone never sends a task to the Mac, and mentioning a Mac in passing doesn't
  either. What it reads shows up as chips you can correct; once you change them they're yours:
  New Task keeps reading as you type, but a different answer only appears as a suggestion with
  **Use this**. While the machines that could take the task differ in those tools, the task waits
  for the answer; if the description is unclear ("the app" in a repo with a website and a native
  app), New Task asks which it is, and the task can't start before you answer — unless the chips
  are already yours. If nothing can be read in time, it says so and adds nothing. A task named for
  a machine is never read. With the decision model (JEV) switched on, a task without screenshots is
  read in one request, in about a second; otherwise, and with screenshots, a helper on the
  autopilot classifier's CLI and model reads it in a few seconds.

### Platform order

When several machines fit a task, the order of platforms decides. Set it under **Settings →
Machines → Automatic choice → Preferred platform**: **Linux, then macOS** (the default) or **macOS,
then Linux**.

- **It ranks only machines that fit.** The requirements decide first: a task that needs Xcode goes
  to the Mac whatever the order. Among machines of the same platform the machine ID decides.
- **Each Shepherd keeps its own.** A task lands on the same machine wherever it is submitted only if
  every connected Shepherd uses the same order. Change it on each of them.
- **It applies to new tasks.** A task that is already waiting or running keeps its machine, and a
  retry under the same `Idempotency-Key` goes where the first submission went.

## Waiting tasks

A task that cannot start on its machine right now stays visible at the top of the herd, labelled
with its machine, in one of four states. Hover the state for what it means and what happens next.

| State                    | Meaning                                                                                                                                            | What happens                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Waiting**              | The machine is asleep or out of reach. Nothing was sent.                                                                                           | It starts there by itself once the machine answers again and a fresh check of its capabilities and its checkout of the project passes.        |
| **Blocked**              | The machine is back, but it lacks a requirement (for example Xcode's license is not accepted) or has no checkout of the project. Nothing was sent. | It starts by itself once a check passes. Fix it on the machine, or run it elsewhere.                                                          |
| **Busy**                 | The machine accepted the task but holds it: it is at its usage limit or at capacity.                                                               | The machine starts it when it has room. Cancel discards it there.                                                                             |
| **Start status unknown** | The task was sent, but no answer came back.                                                                                                        | Shepherd asks the machine, then shows the session or sends the same task again if it never arrived (see [above](#start-a-task-on-a-machine)). |

- **Waiting survives restarts.** The task is stored on your Shepherd. After a restart it is still
  listed and still starts once its machine is back.
- **Attachments travel late.** They are uploaded to the machine only when the task is actually
  sent, and are kept on your Shepherd until then, also beyond the usual 24 hours.
- **Cancel** removes a waiting or blocked task; nothing was ever sent. A busy task is discarded on
  the machine; if it started there in the meantime, it keeps running.
- **Run on another machine.** A waiting or blocked task offers **Run here** or **Run on …** for
  each connected machine that fits it right now, including your Shepherd. It starts there at once.
  A machine that does not fit is refused with the reason, and the task keeps waiting. A busy task
  is not moved: cancel it and start it again.
- **Only preferred is still waited for.** A task without requirements submitted on the MacBook while
  Linux is asleep waits for Linux, because Linux is preferred, and offers the MacBook as
  **Run here**. Nothing falls back by itself.
- **Removing a machine** cancels the tasks waiting for it.
- Only the automatic choice waits. A machine you name under **Run on** or in `target` must be
  reachable, or nothing starts.

From a script, a create that waits answers `200` with `held: true` and `waiting: true`; cancel it
with `DELETE /api/remote-dispatches/{id}` and redirect it with
`POST /api/remote-dispatches/{id}/redirect` ([External Task API](external-task-api.md)).

## When nothing starts

Some tasks are refused before anything is sent: nothing is stored, waited for or started on another
machine. New Task shows the reason as a warning before you start, and again if you start anyway; the
API answers with a code ([External Task API](external-task-api.md)).

| New Task says                                             | Why                                                                                                                                         | API                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| "No connected machine has Xcode — nothing will start."    | No connected machine with the project has every requirement. A machine that has them but no checkout is named too.                          | `422 no_suitable_machine` with `missing` and `elsewhere` |
| "MacBook is missing Xcode (license not accepted)."        | The machine picked under **Run on** lacks a requirement. "This machine is missing …" when this Shepherd's own fresh check refuses the task. | `422 missing_capabilities` with `missing` (and `host`)   |
| "MacBook isn't reachable right now."                      | The picked machine dropped off before you started. Only the automatic choice waits for a machine; a machine you pick must be reachable.     | `409 remote_target_unavailable`                          |
| "MacBook has no checkout of this project."                | The picked machine has no checkout with the project's forge remote.                                                                         | `422 remote_project_missing`                             |
| "… runs on a platform that isn't released for tasks yet." | A Windows machine named through the API ([Windows](#windows-modeled-not-released)).                                                         | `422 remote_target_unreleased`                           |

Together with the machine's status (Connected, Unreachable, …) and the four states of a waiting
task, every reason a task does not run is shown as itself: offline, busy, a missing capability, an
unknown start or a refusal. None of them falls back to another machine.

## Work with its sessions

A session on another machine sits in the herd's lifecycle groups among your own, by the PR state
its machine reports: one that waits on you is under **Your turn**, with a label in its machine's
color. The machine bar under the lenses narrows the herd to one machine; it lists every connected
machine with its session count, one with none too, and marks one that can't be reached as
**disconnected**. The jump to the next waiting session includes blocked sessions on connected
machines.

Select a session on another machine in the herd. From the coordinator you can use its terminal, steer, stop
and archive it, read its activity, diff and files, answer its plan, and start or open its preview,
which opens from the machine's own tailnet address. Merging, relaunching and the remaining actions
are not offered for it yet: open the Shepherd on that machine for those.

When the machine drops off, for example asleep or offline, its sessions stay in the herd with their
last known state, dimmed and marked **disconnected**. Nothing is sent while it is gone, and the terminal says
so. Once the machine answers again, the same sessions come back live.

A client only needs to connect to the coordinator. If a client connects to several Shepherds, as
the iOS app can, it still shows each session once.

Notifications work the same way. When a session on a connected machine finishes, blocks, gets a
critic review or asks you to log in, the coordinator notifies the devices that are not registered
with that machine themselves. A device registered with both hears it once, from the machine.
Anything that happened while the machine was disconnected is not announced afterwards. Browsers and
iOS apps that predate this only get the coordinator's own notifications.

## Update its Shepherd

When a connected machine's Shepherd is behind its branch, the update badge in the top bar lights up
for it too. With other machines involved the badge counts machines instead of commits; hover it to
see which machine needs how many commits. Its window lists every machine: this one, each machine
that is behind with the commits it would get, and the ones that are up to date or out of reach.

- **One machine:** **Update** in its row. The coordinator follows the machine's deploy until its new
  version is live.
- **All at once:** **Update all** starts every machine that is behind together. This machine goes
  last, because its update restarts Shepherd and reloads the page.
- **Local changes on a machine:** when uncommitted changes in the machine's checkout block the pull,
  its row lists them. Discard them and update, or skip the machine and commit them there yourself.
  This machine waits for that choice.

A machine updates itself the way its own window would, so the same rules apply there. A Shepherd run
by the Mac app updates through the app: its row reports that the update could not start.

## The trust decision

Connecting a machine hands the coordinator a Full token for it. Decide that as you would hand
someone your login.

- **What the token allows:** everything you can do on that machine: start agents, steer sessions
  and their live terminals, and administer it, across every repository. Anyone who can sign in to
  the coordinator gets that reach through it. Only connect Shepherds you control.
- **Where it is kept:** in the coordinator's database, on the server. It is never shown again, sent
  to a browser or app, or written to a log, and only goes to that machine, in the `Authorization`
  header. Redirects are never followed.
- **How to cut it:** revoke the token on the machine under **Settings → Access**; that takes effect
  at once. **Remove** on the coordinator forgets the address and the token there; revoke it on the
  machine as well.
- **Who can reach the address:** the devices your Tailscale access rules let through. Beyond the
  health check they still need the password or a token.
- **No extra rights:** a request through the coordinator is checked against the caller's own scope
  and repositories first, and the machine checks everything again itself.

## Limits

- **No unpushed changes.** The machine works from its own checkout and the base branch as pushed to
  origin. Commits and edits that exist only on the coordinator don't travel.
- **No live migration.** A session stays on the machine it started on. To continue elsewhere, push
  its branch and start a new task there.
- **No silent fallback.** A task meant for a machine that is out of reach does not start on
  another one by itself: it waits for that machine until you cancel it or run it elsewhere.
- **Follow-up work stays on the machine:** review, pull request and merge are its Shepherd's.
- **No cloning.** A machine works from its own checkout of the project. Shepherd never clones one
  for it.
- **No waking up.** Shepherd doesn't wake a sleeping machine (no Wake-on-LAN). A task waiting for it
  starts once you wake it.
- **One machine per task.** A task for several platforms ("change it on macOS, iOS and Android") is
  not split into one task per platform. Split it yourself.
- **No rule files.** The choice is made per task, from what it needs, never from rules kept in the
  repository or a subproject.
- **Each Shepherd keeps its own.** Drain and epics, merging, settings (the platform order too),
  usage limits and backlogs stay with each Shepherd. Nothing is merged across machines.
- **Windows** is listed, but not released for tasks ([below](#windows-modeled-not-released)).

## Windows: modeled, not released

Windows is part of the model, but no task runs on it yet: Shepherd itself, its herdr connection, its
paths and worktrees are not proven on Windows. That is separate work.

- A Shepherd on Windows can be connected. **Settings → Machines** lists it with its platform and
  checked capabilities, marked **Not released**.
- The automatic choice never picks it, and **Run on** doesn't offer it. Named through the API it is
  refused with `remote_target_unreleased`, and nothing is sent.
- On its own it doesn't turn the automatic choice on: with only Windows machines connected, New Task
  stays as it is without machines.
- It becomes a machine for tasks only once Shepherd's compatibility with Windows is proven.

## Test a branch on two machines

A released Shepherd doesn't know endpoints still in review, so for those both machines run the
branch. Keep it apart from the Shepherd you use every day: its own port, database, herdr session
and checkouts, so the live instance is never touched or restarted.

**Linux**, next to a live Shepherd on port 7330. Run these from a plain terminal, not from inside
a herdr pane:

```bash
git -C <your shepherd checkout> fetch origin <branch>
git -C <your shepherd checkout> worktree add ~/shepherd-branch FETCH_HEAD
cd ~/shepherd-branch && bun install && (cd ui && bun install && bun run build)

# a separate clone of the project to test with, outside the live instance's checkouts
mkdir -p ~/.shepherd-branch ~/shepherd-acceptance
git clone <project url> ~/shepherd-acceptance/<repo>

# the branch's own herdr session; keep it running in a second terminal
herdr --session branch server

SHEPHERD_PORT=7350 \
SHEPHERD_DB="$HOME/.shepherd-branch/shepherd.db" \
SHEPHERD_REPO_ROOT="$HOME/shepherd-acceptance" \
SHEPHERD_PREVIEW_PORT_BASE=8201 \
HERDR_SESSION=branch \
bun run start
```

- `SHEPHERD_PORT=7350` keeps it off the live port; its agent listener takes the next port, 7351.
- `SHEPHERD_DB` gives it its own password, tokens, machines and sessions. A fresh database prints a
  generated password once; set `SHEPHERD_PASSWORD` to choose one.
- `SHEPHERD_REPO_ROOT` points at the separate clone, so the live instance's checkouts and worktrees
  stay out of it.
- `SHEPHERD_PREVIEW_PORT_BASE=8201` gives its previews their own ports. Required: at startup
  Shepherd clears its whole preview range (8001–8016 by default) from `tailscale serve`, which
  would remove the live instance's preview mappings.
- `HERDR_SESSION=branch` gives its agents their own herdr session, apart from the live herd.

Make it reachable with `tailscale serve --bg --https 7350 http://127.0.0.1:7350`
(`https://<host>.<tailnet>.ts.net:7350`). Afterwards stop it with Ctrl-C, remove the mapping with
`tailscale serve --https=7350 off`, and stop and delete its herdr session with
`herdr --session branch server stop` and `herdr session delete branch`.

**Mac:** follow **Two-machine test from a branch checkout** under
[Reach the local server from your tailnet](../native/docs/getting-started.md#reach-the-local-server-from-your-tailnet)
in the Mac guide: its own worktree, database and herdr session, reachable in the tailnet.

## Check a two-machine setup end to end

Run this after setting up, after an update, and to accept a change to this feature. Linux is the
coordinator, the Mac the machine; the project is checked out on both.

| #   | Step                                                                                       | Expected                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Connect the Mac on Linux, and Linux on the Mac.                                            | Both show **Connected**, with version, platform, projects and capabilities (Xcode, SDKs, simulator on the Mac).                    |
| 2   | On Linux, start an Xcode task (build and test the app) with **Run on: MacBook**.           | It starts on the Mac: worktree, agent and `xcodebuild` run there, with no system dialog waiting. Linux lists it under the MacBook. |
| 3   | Open its terminal on Linux and type.                                                       | The live terminal of the Mac session; input reaches the agent there.                                                               |
| 4   | Steer it with a reply.                                                                     | The agent on the Mac receives it.                                                                                                  |
| 5   | Stop it.                                                                                   | The agent on the Mac stops its turn.                                                                                               |
| 6   | Open its diff and files.                                                                   | The Mac worktree's changes and files.                                                                                              |
| 7   | Start its preview.                                                                         | It runs on the Mac and opens from the Mac's tailnet address.                                                                       |
| 8   | Put the Mac to sleep, then wake it.                                                        | Linux marks its sessions disconnected with the last known state; after waking, the same sessions come back live.                   |
| 9   | Cut the network (Tailscale off on the Mac), try a reply and the terminal, then restore it. | Linux says the Mac isn't reachable, sends nothing and runs nothing itself; after restoring, everything works again.                |
| 10  | On the Mac, start a task with **Run on:** the Linux machine.                               | It runs on Linux and shows up on the Mac under the Linux machine.                                                                  |
| 11  | Connect the iOS app to both Shepherds.                                                     | Every session appears exactly once.                                                                                                |
| 12  | Archive the task from Linux.                                                               | It is archived on the Mac and leaves both herds.                                                                                   |
| 13  | When testing a branch: check the live instance.                                            | It kept running throughout; its database, herdr session, checkouts and preview mappings were never touched.                        |
| 14  | On Linux and on the Mac, open New Task on **Automatic**, add the **Xcode** requirement.    | Both say "Runs on MacBook — Needs Xcode"; started from either side, it runs on the Mac.                                            |
| 15  | Remove the requirement and start it on each side.                                          | Both say "No special requirements – preferred: Linux"; it runs on Linux, and the session shows that reason.                        |
| 16  | Put the Mac to sleep and start the Xcode task on Linux.                                    | It waits: Linux shows **Waiting** in the MacBook's group, with "Needs Xcode". Nothing runs on Linux instead.                       |
| 17  | Restart the Linux Shepherd, then wake the Mac.                                             | The task is still waiting after the restart; once the Mac is back it starts there, once.                                           |
| 18  | Put the Mac to sleep again, start another Xcode task and pick **Run here** on Linux.       | Not offered: Linux lacks Xcode. Through the API the redirect is refused with `missing_capabilities`; the task keeps waiting.       |
| 19  | Cancel that waiting task, then wake the Mac.                                               | It never starts anywhere.                                                                                                          |
| 20  | On Linux, type "Erweitere die native macOS-App" in New Task.                               | The chip **Xcode** appears, and it says "Runs on MacBook — Needs Xcode".                                                           |
| 21  | Replace the prompt with "Implementiere die Web-Einstellungen".                             | No chip, and "No special requirements – preferred: Linux".                                                                         |
| 22  | Replace it with "Passe die App an das neue Logo an".                                       | New Task asks what the task needs; **Start** stays disabled until you pick an answer.                                              |
| 23  | On Linux, add the **Xcode** chip and pick **This machine** under **Run on**.               | New Task warns that the Linux machine is missing Xcode; starting it anyway starts nothing.                                         |
| 24  | Make Xcode go missing while a task waits ([below](#xcode-missing-on-purpose)).             | **Blocked** in the MacBook's group, naming Xcode: only the Command Line Tools. Nothing starts.                                     |
| 25  | Bring Xcode back ([below](#xcode-missing-on-purpose)).                                     | The task starts on the Mac, once.                                                                                                  |
| 26  | Lose an answer on purpose ([below](#lose-an-answer-on-purpose)).                           | One session on the Mac; the repeated request answers that same session. Nothing runs twice.                                        |
| 27  | In Shepherd for Mac and on iOS, repeat 14, 15 and 20–22.                                   | The same reason and question as in the web UI; each task starts on the same machine.                                               |
| 28  | On the Mac, remove the Linux machine, then open Settings → Machines on the Mac.            | Linux shows under **They see your sessions** as **One direction only**, with **Connect … here**; reconnected: **Both directions**. |

### Xcode missing on purpose

Rows 24 and 25 check that a missing Xcode is named and that nothing starts without it.

1. Turn Tailscale off on the Mac and start an Xcode task on Linux: it waits for the MacBook.
2. On the Mac, select the Command Line Tools instead of Xcode, then turn Tailscale on:

   ```bash
   sudo xcode-select -s /Library/Developer/CommandLineTools
   ```

   Before Linux sends the task, it asks the Mac for a fresh check. That check finds only the
   Command Line Tools, so the task is **Blocked**, and Settings → Machines on Linux names it too.

3. Select Xcode again, choose **Check capabilities** in Settings → Machines on the Mac (or wait up
   to five minutes for its own check), then **Check now** for the MacBook on Linux:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   ```

### Lose an answer on purpose

Row 26 needs an access token on the Linux branch Shepherd and the absolute path of its checkout of
the project. On the Linux host, send the task and stop the branch Shepherd hard a second later. Stop
it by the process that listens on its loopback port, not by port alone: `tailscale serve` listens on
the same port number.

```bash
pid=$(ss -ltnpH 'src 127.0.0.1:7350' | grep -o 'pid=[0-9]*' | cut -d= -f2)
curl -s -X POST https://<linux>.<tailnet>.ts.net:7350/api/sessions \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: acceptance-lost-1' \
  -d '{"repoPath":"<checkout>","baseBranch":"main","prompt":"Build the macOS app and run its tests","requirements":["xcode"]}' &
sleep 1; kill -9 "$pid"
```

Start the branch Shepherd again as before, then send the same `curl` once more. Whether it stopped
before or after the task reached the Mac, the task runs there exactly once.

The automated counterpart, `test/machines-two-instances.test.ts`, runs in `bun run test`: two
Shepherd processes with their own ports and state, a cut network between them and a crash of the
coordinator. It covers manual assignment, the automatic choice from either Shepherd and client, the
question about an unclear task, a lost answer, and a task that waits for an unreachable or
Xcode-less Mac across a crash of the coordinator and starts there once the Mac is back.
