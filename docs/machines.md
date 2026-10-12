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
  started there directly or by its own automation. Your Shepherd mirrors them into its herd, grouped
  under the machine (`MacBook · TASK-07`), and never treats them as its own: no poller, autopilot,
  drain or reaper on your side touches them. A mirrored session is never passed on, so two machines
  connected to each other neither loop nor show a session twice.
- **Actions go to the machine.** The terminal, steering, stopping, archiving, the diff, the files
  and the preview are sent to the machine and run there. While the machine can't be reached,
  nothing is sent and nothing runs on your side in its place.
- **A new task is handed over once.** It goes out with a dispatch ID, so sending it again never
  starts it twice there, even after a lost answer or a restart.

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
coordinator.

## Start a task on a machine

In **New Task**, **Run on** starts on **Automatic**: Shepherd chooses the machine (see
[Automatic choice](#automatic-choice)) and shows which one and why before you start, for example
"Runs on MacBook — Needs Xcode". To choose yourself, pick **This machine** or a connected machine
that has the project checked out and runs a platform released for tasks (Linux, macOS). A machine
you pick must have what the task needs, or nothing starts and the dialog says what is missing.

- The machine starts from the base branch **as pushed to origin**. Push first.
- Attachments are uploaded to the machine right before the task is sent. If one can't be sent, the
  task doesn't start.
- A refusal or a hold on the machine is shown with its reason.
- If no answer comes back, the task shows as **Start status unknown** in that machine's group of
  the herd. Shepherd asks the machine as soon as it can be reached, also after a restart of your
  Shepherd, and then about once a minute. It then shows the session, or sends the same task again
  if it never arrived. It never starts twice and never goes elsewhere. Until the machine confirms
  it, you can cancel it.

From a script, leave `target` out for the automatic choice, or send `target: { instanceId }` to
name the machine, with the create request and an `Idempotency-Key`
([External Task API](external-task-api.md)).

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
  nothing starts: Shepherd says which machine it is and which others would fit. It never falls back
  to another machine on its own. Pick one under **Run on** to start it there.
- **Requirements are not guessed yet.** Shepherd reads only the requirements you give it. Without
  any, a task runs on the preferred platform.

## Work with its sessions

Select a mirrored session in the herd. From the coordinator you can use its terminal, steer, stop
and archive it, read its activity, diff and files, answer its plan, and start or open its preview,
which opens from the machine's own tailnet address. Merging, relaunching and the remaining actions
are not offered for it yet: open the Shepherd on that machine for those.

When the machine drops off, for example asleep or offline, its sessions stay in the herd with their
last known state, marked **disconnected**. Nothing is sent while it is gone, and the terminal says
so. Once the machine answers again, the same sessions come back live.

A client only needs to connect to the coordinator. If a client connects to several Shepherds, as
the iOS app can, it still shows each session once.

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
  another one by itself. Waiting for it is not supported yet.
- **Follow-up work stays on the machine:** review, pull request and merge are its Shepherd's.
- **Windows** is listed as a platform, but not released for tasks.

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
| 16  | Put the Mac to sleep and start the Xcode task on Linux.                                    | Nothing starts: Linux says the MacBook would run it but is not reachable. Nothing runs on Linux instead.                           |

The automated counterpart, `test/machines-two-instances.test.ts`, runs in `bun run test`: two
Shepherd processes with their own ports and state, a cut network between them and a crash of the
coordinator.
