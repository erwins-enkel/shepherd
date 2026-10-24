# Shepherd for Mac

**Your AI coding agents. One native Mac workspace.**

Keep parallel coding work in view without hunting through terminal windows and browser tabs.
Shepherd for Mac brings your sessions, code changes and pull requests together, so you can see
what needs attention and give your agents direction.

**[⬇ Download for macOS](https://github.com/erwins-enkel/shepherd/releases?q=macos-)** · [Get started →](docs/getting-started.md) ·
[See more screenshots](docs/screenshots.md) · [Discover Shepherd](../README.md)

![Shepherd for Mac with session filters, usage gauges and the selected agent's activity](docs/screenshots/01-sessions-and-activity.png)

## Less chasing. More deciding.

- **See the work at a glance.** Browse your sessions, filter by repo or state and keep usage in view.
- **Understand what changed.** Read an agent's activity, inspect its diff and browse its files in
  the same workspace.
- **Give direction when it matters.** Attach to the live terminal, send a message and take the
  session actions you need.
- **Keep the pull request close.** Check its state and checks, request a review or merge without
  losing the context of the task.
- **Let the app call you back.** Native notifications help you follow work while your attention
  is elsewhere.

## A Mac workspace for your Shepherd server

Use a server on your Mac or connect to a remote one. If your agents run on a Linux machine, the
Mac app gives you a native place to follow and steer that work. Your existing Shepherd sessions
are there when you connect.

Sessions on a connected machine use the same cards, context menus, eight detail tabs and steering
controls as sessions on your selected server. For example, when connected to Mo, a MacBook session
uses Mo's saved steering templates and sends its actions to the MacBook. A lost machine connection
keeps its last data visible and disables session actions until reconnection. See
[connected machines](../docs/machines.md#macos-session-controls) for verification and version requirements.

When closing the window or quitting, choose whether to keep the app-managed local backend
running or stop it too. Keeping it running lets sessions and other clients continue; stopping
it makes its web UI and client connections unavailable until it is started again and may
interrupt local work. Remote servers keep running in either case. App restarts, automatic
updates and dev rebuilds keep the backend running; the next launch resumes supervision.
You can also use **Stop** or **Restart** in **Run on this Mac** to control the server. A dev
rebuild retains the running server code; **Restart** explicitly loads the updated code.

On battery power, a prominent panel at the top right of the display asks whether to keep local
work running or **Pause until plugged in**. It stays visible across app switches until you choose
or external power returns. Continuing dismisses it for the current battery cycle. The same
decision is available in the Shepherd menu; **Resume now** overrides an active pause.

Battery pause requires the current, app-managed local backend. It suspends that server and its
recorded agent/terminal process trees, including local tools and previews. A bundled helper
automatically resumes only the processes it suspended when external power returns, even after
quitting the app. Existing stopped processes stay stopped. Remote agent processes keep running,
although a connection routed through the paused local server is unavailable until it resumes.
Long-running network requests may time out during a pause and need retrying afterwards.

Ownership and private logs in `~/.shepherd/run/` are scoped by port and canonical installation
and database paths. Adoption and every signal validate the kernel process start time, so a
reused PID cannot grant ownership. Generated boot passwords use a separate 0600 one-shot file,
read and removed by the app, and never enter the server log. If the app quits during boot, the
next adoption removes that file without offering the old password again.

Logs use append mode and copy-truncate at 10 MiB on spawn, adoption and while the app observes
the server; the previous copy is capped at 10 MiB. The tail follows truncation and file
replacement. While the app is closed, log growth is bounded only at the next app start.
Continuous maintenance while closed would require an additional persistent logging service.
Older running apps still stop their server on quit: the dev preflight retains its live-session
checks unless the running app has a matching live ownership record.

The app is a client for Shepherd: it needs a running Shepherd server. The server runs the agents;
the app is where you see their progress, inspect results and make decisions.

## Early, useful and growing

The app is an **early preview**, already usable day to day. Available today:

- **Sessions:** the herd sidebar with task descriptions, runtime model and effort, lifecycle
  stages, repo and state filters and usage meters. Cards open task details, review results and
  session actions, and flag costly resumes after the prompt cache expires.
- **Session detail:** activity, diff, files, git and the live terminal.
- **Connected machines:** sessions running on a machine connected to your server appear in a group
  of their own, labelled with that machine and the state of its connection; their terminal opens
  here too. New Task's **Run on** leaves the machine to the server (Automatic) or names one, shows
  why and asks when a task's needs are unclear; tasks waiting for their machine can be canceled or
  run elsewhere.
- **Review and merge:** plan gates, pull-request actions, review requests and merge automation.
- **Starting work:** a new-task composer that starts from an issue, plus held tasks, Up Next and
  the Done panel.
- **Around the app:** a command palette, the local-server panel and native notifications.

The interface supports English and German; the screenshots show a live instance in German.

The backlog and epic management are still web-only. Use the browser for those.

## Download and install

Requires **macOS 15 or newer**.

1. Open the [Mac releases](https://github.com/erwins-enkel/shepherd/releases?q=macos-) and pick the newest **Shepherd for Mac** release.
2. Download `Shepherd-<build>.dmg`, open it and drag **Shepherd.app** onto the Applications shortcut.
3. Open Shepherd from Applications and confirm macOS's “downloaded from the internet” prompt.
   The app is signed with Developer ID and notarized by Apple.

After that, updates arrive automatically. Details: [first installation](docs/app-updates.md#first-installation).
Prefer to build it yourself? The [getting-started guide](docs/getting-started.md) covers building
from source with Xcode and connecting to a server. Connecting to a remote Linux server gives you
the fully supported server platform; running the server on a Mac has
[reduced capabilities](../docs/getting-started.md#os-matrix).

## Make it your workspace

**[Get started with Shepherd for Mac →](docs/getting-started.md)**

Explore the [screenshot tour](docs/screenshots.md),
[share feedback](https://github.com/erwins-enkel/shepherd/discussions) or
[report an issue](https://github.com/erwins-enkel/shepherd/issues).

Tester distribution: [automatic app updates and release setup](docs/app-updates.md).

For contributors: [build, test, signing and architecture](docs/development.md), including
[ShepherdKit](docs/development.md#shepherdkit), the Swift client package behind the app.
