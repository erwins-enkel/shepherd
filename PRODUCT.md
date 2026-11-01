# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo power-user on a Claude Max/Pro subscription or API-key auth, running many coding agents at once and acting as their single operator. Desktop is the primary surface (a wide HUD with a live terminal pane, in the browser or the Mac app); mobile, through the phone browser or the iPhone app, is for monitoring the herd and light steering on the go. The operator is technical, lives in a terminal, and reaches for Shepherd to stop being the bottleneck across a dozen parallel sessions. Context is often long and unattended: glancing at status between other work, or checking in at 2am to see who is blocked.

The job to be done: parallelize many real interactive agent sessions without losing oversight, and steer any of them the moment they need a human, from wherever the operator is.

## Product Purpose

Shepherd is self-hosted mission control for **interactive** coding agents: Claude Code first, with the Codex CLI in alpha. It spawns genuine agent sessions in isolated git worktrees (via [`herdr`](https://herdr.dev), [Can Celik](https://github.com/ogulcancelik)'s agent multiplexer — the substrate without which this whole project wouldn't be possible), bridges each PTY to a live terminal in the browser and native clients, and lets one operator observe and steer a whole herd in parallel.

The defining constraint is the ToS-compliance model, not a footnote: Shepherd only **observes** (reads the terminal and agent status) and **steers** (injects keystrokes into the live pane). By default it uses no Agent SDK or `claude -p`; if a feature cannot be done by typing into a real terminal, it does not ship. This model is Shepherd's **design stance** — running on the operator's own subscription through genuine interactive sessions — rather than an official Anthropic ruling; operators who prefer a clearly-compliant path can opt into metered API-key auth. This constraint shapes the product's soul, and the UI should make that interactive-terminal reality felt, not hidden behind abstraction.

The second pillar carries equal weight: Shepherd is opinionated about how agent-built software ships. Parallel agent work erodes engineering discipline unless something institutionalizes it, so Shepherd builds the discipline in. The pipeline itself is gated: the Plan gate puts every autonomous run's plan through adversarial review first, the Critic reviews every CI-green PR the same way, and the Merge train sends any PR that has fallen behind its base back to its agent to rebase, and CI and the critic re-run before it lands. The discipline is ambient too: Readiness scores a JS/TS repo's guardrails before agents are pointed at it, and hygiene gates enforce linear branches, locale parity, feature-catalog completeness, and a dead-code/complexity audit.

Success looks like: one operator confidently running many agents, knowing at a glance who is working, who is idle, and who is blocked and needs them; reaching the right session and steering it in seconds; and trusting the tool enough to leave it running.

## Positioning

Shepherd runs real interactive agent sessions in a PTY, not an SDK or headless wrapper: it only observes and steers what a human could at a terminal. It pairs that with an opinionated shipping pipeline (Plan gate, Critic, Merge train) on the operator's own server and agent login.

## Operating Context

- The server runs on the operator's own machine, typically reached remotely over Tailscale. Agents keep running across Shepherd restarts because their PTYs live in herdr.
- Claude Code sessions use the operator's own `~/.claude`, so existing slash commands, skills and plugins carry over.
- GitHub issues and pull requests are the usual source and destination of work. Each session owns a git worktree and tracks one PR.
- Use is mostly glances between other work, with fast routing to the one session that needs a human. Phone check-ins happen away from the desk and at odd hours.
- A session's context includes its Shared Browser and dev-server previews, reachable from the operator's phone.
- Autonomy is opted into, not assumed: the operator chooses per task and per repo how much runs unattended.

## Capabilities and Constraints

**Surfaces.** The web UI has the broadest feature set. Shepherd for Mac is a native SwiftUI early preview (macOS 15+) that connects to a local or remote server. The native iPhone app is distributed through TestFlight.

**Capabilities.** Interactive agent control, session chat, Multi-CLI, Plan gate, Critic, Merge train, Readiness, Autopilot, Epics and sub-issues, Up Next, Schedules, Operator Assistant, multiple machines, visual plans and recaps, dev-server preview, usage-aware task holds, and the command bar.

**Server platforms.** Linux with systemd is the only fully supported target. macOS runs core-only, without the sandbox membrane, egress allowlist or auto-drain. Windows is supported only through WSL2.

**License.** Business Source License 1.1 © Erwins Enkel GmbH: source-available, not open source.

**Language.** All product UI copy ships in EN and DE catalogs.

**Terminology.** The canonical domain language lives in `CONTEXT.md`.

## Brand Commitments

Terminal-native instrument. Three words: **technical, composed, earned.**

In the product UI, voice and tone are spare and precise, the register of an operator talking to an operator. No marketing warmth, no hand-holding, no exclamation. Labels are short and literal; the interface assumes competence. README, marketing site and docs use plain, welcoming language instead, for readers who have not met the product yet. The UI reads like mission telemetry or aircraft instrumentation: monospace, dense, phosphor-green, status pips and gauges that mean something. Personality comes from restraint and fitness for purpose, not from decoration. The voice is also prescriptive: the product has opinions about how agent-built software ships, and it states them plainly. The product earns trust by being quiet until something needs attention, then making that signal unmistakable.

## Anti-references

This must NOT look like any of the following:

- **Generic SaaS dashboard.** No cards-everywhere layouts, pastel gradients, hero-metric tiles, or Inter-on-white. The Vercel/Linear-clone reflex is the enemy.
- **Consumer chat app.** No bubbly, emoji-forward, soft-and-friendly Slack/Discord coziness that undercuts the operator-tool seriousness.
- **Enterprise admin panel.** No heavy chrome, dense gray Bootstrap-era toolbars, or Jira-style density-without-elegance.
- **Crypto/gamer neon.** No glowing neon-on-black, RGB accents, glassmorphism, or sci-fi overdrive. Style must never outrun signal.

The throughline: every pixel is telemetry. Nothing decorative, nothing that makes a serious tool look like a toy or a template.

## Evidence on Hand

- Web UI screenshot: `site/public/app-screenshot.webp`.
- Mac app screenshots: `native/docs/screenshots/`.
- 30-second explainer: `docs/media/shepherd-explainer.mp4`, with source in `docs/media/explainer/`.
- Interactive demo on a simulated backend: https://demo.shepherd.run, linked from `site/src/components/LiveDemo.astro`.
- Production use: "actively developed and used in production by its authors" (`README.md`).

The repo holds no testimonials, customer logos, press, usage numbers or published benchmarks. Do not fabricate any of them.

## Product Principles

1. **Instrument, not dashboard.** Every element is telemetry that earns its place. No decorative chrome, no hero metrics, no cards for their own sake. If it does not help the operator observe or steer, it does not belong on screen.
2. **Quiet until it needs you.** The interface stays calm and low-noise by default; the blocked / needs-you state is unmistakable. Attention is a budget, spend it only on what is actionable.
3. **Steer like a human at a terminal.** The ToS model is the product, not a limitation to abstract away. (It is Shepherd's design stance, not an official Anthropic ruling.) The UI mirrors genuine interactive terminal use (observe the real pane, type to steer) and should make that reality legible rather than papering over it.
4. **Density with legibility.** Pack many agents into one pane without sacrificing per-agent readability. It has to work at 2am in a dim room and on a phone with one thumb. Contrast and hierarchy carry the load, not size.
5. **Remove the operator as bottleneck.** One operator, many agents, no choke point. Design for parallel oversight at a glance and fast routing to the one session that needs a human now.
6. **Opinionated pipeline, visible guardrails.** The discipline features (Readiness, Plan gate, Critic, Merge train, hygiene gates) are product, not plumbing. Surface what each gate enforces and why, and let the operator see a gate doing its job rather than hide it behind background machinery.

## Accessibility & Inclusion

- Baseline **WCAG 2.1 AA** contrast across both dark (default) and light themes, already established in the runtime palette (`--ink` ~12:1, `--muted` ~5.5:1 on `--bg`).
- **Mobile and touch:** phone steering is a first-class use case. Comfortable hit areas and thumb-reachable controls on small screens; the live terminal and steer controls must be usable one-handed.
- **Status must not rely on hue alone.** Status (working / idle / blocked / done) is the core signal; it is already paired with position and pips, and should keep a non-color cue (shape, icon, or label) wherever it carries meaning.
