# Product

## Register

product

## Users

Solo power-user on a Claude Max/Pro subscription, running many `claude` agents at once and acting as their single operator. Desktop is the primary surface (a wide HUD with a live terminal pane); mobile is for monitoring the herd and light steering on the go. The operator is technical, lives in a terminal, and reaches for Shepherd to stop being the bottleneck across a dozen parallel sessions. Context is often long and unattended: glancing at status between other work, or checking in at 2am to see who is blocked.

The job to be done: parallelize many real interactive `claude` sessions without losing oversight, and steer any of them the moment they need a human, from wherever the operator is.

## Product Purpose

Shepherd is self-hosted mission control for **interactive** Claude Code. It spawns genuine `claude` sessions in isolated git worktrees (via [`herdr`](https://herdr.dev), [Can Celik](https://github.com/ogulcancelik)'s agent multiplexer — the substrate without which this whole project wouldn't be possible), bridges each PTY to a browser terminal, and lets one operator observe and steer a whole herd in parallel.

The defining constraint is the ToS-compliance model, not a footnote: Shepherd only **observes** (reads the terminal and agent status) and **steers** (injects keystrokes into the live pane). By default it uses no Agent SDK or `claude -p`; if a feature cannot be done by typing into a real terminal, it does not ship. This model is Shepherd's **design stance** — running on the operator's own subscription through genuine interactive sessions — rather than an official Anthropic ruling; operators who prefer a clearly-compliant path can opt into metered API-key auth. This constraint shapes the product's soul, and the UI should make that interactive-terminal reality felt, not hidden behind abstraction.

The second pillar carries equal weight: Shepherd is opinionated about how agent-built software ships. Parallel agent work erodes engineering discipline unless something institutionalizes it, so Shepherd builds the discipline in. The pipeline itself is gated: the Plan gate puts every autonomous run's plan through adversarial review first, the Critic reviews every CI-green PR the same way, and the Merge train sends any PR that has fallen behind its base back to its agent to rebase, and CI and the critic re-run before it lands. The discipline is ambient too: Readiness scores a JS/TS repo's guardrails before agents are pointed at it, Learnings distill past sessions into house rules that are injected into new ones, and hygiene gates enforce linear branches, locale parity, feature-catalog completeness, and a dead-code/complexity audit.

Success looks like: one operator confidently running many agents, knowing at a glance who is working, who is idle, and who is blocked and needs them; reaching the right session and steering it in seconds; and trusting the tool enough to leave it running.

## Brand Personality

Terminal-native instrument. Three words: **technical, composed, earned.**

Voice and tone are spare and precise, the register of an operator talking to an operator. No marketing warmth, no hand-holding, no exclamation. Labels are short and literal; the interface assumes competence. It reads like mission telemetry or aircraft instrumentation: monospace, dense, phosphor-green, status pips and gauges that mean something. Personality comes from restraint and fitness for purpose, not from decoration. The voice is also prescriptive: the product has opinions about how agent-built software ships, and it states them plainly. The product earns trust by being quiet until something needs attention, then making that signal unmistakable.

## Anti-references

This must NOT look like any of the following:

- **Generic SaaS dashboard.** No cards-everywhere layouts, pastel gradients, hero-metric tiles, or Inter-on-white. The Vercel/Linear-clone reflex is the enemy.
- **Consumer chat app.** No bubbly, emoji-forward, soft-and-friendly Slack/Discord coziness that undercuts the operator-tool seriousness.
- **Enterprise admin panel.** No heavy chrome, dense gray Bootstrap-era toolbars, or Jira-style density-without-elegance.
- **Crypto/gamer neon.** No glowing neon-on-black, RGB accents, glassmorphism, or sci-fi overdrive. Style must never outrun signal.

The throughline: every pixel is telemetry. Nothing decorative, nothing that makes a serious tool look like a toy or a template.

## Design Principles

1. **Instrument, not dashboard.** Every element is telemetry that earns its place. No decorative chrome, no hero metrics, no cards for their own sake. If it does not help the operator observe or steer, it does not belong on screen.
2. **Quiet until it needs you.** The interface stays calm and low-noise by default; the blocked / needs-you state is unmistakable. Attention is a budget, spend it only on what is actionable.
3. **Steer like a human at a terminal.** The ToS model is the product, not a limitation to abstract away. (It is Shepherd's design stance, not an official Anthropic ruling.) The UI mirrors genuine interactive terminal use (observe the real pane, type to steer) and should make that reality legible rather than papering over it.
4. **Density with legibility.** Pack many agents into one pane without sacrificing per-agent readability. It has to work at 2am in a dim room and on a phone with one thumb. Contrast and hierarchy carry the load, not size.
5. **Remove the operator as bottleneck.** One operator, many agents, no choke point. Design for parallel oversight at a glance and fast routing to the one session that needs a human now.
6. **Opinionated pipeline, visible guardrails.** The discipline features (Readiness, Plan gate, Critic, Learnings, Merge train, hygiene gates) are product, not plumbing. Surface what each gate enforces and why, and let the operator see a gate doing its job rather than hide it behind background machinery.

## Accessibility & Inclusion

- Baseline **WCAG 2.1 AA** contrast across both dark (default) and light themes, already established in the runtime palette (`--ink` ~12:1, `--muted` ~5.5:1 on `--bg`).
- **Mobile and touch:** phone steering is a first-class use case. Comfortable hit areas and thumb-reachable controls on small screens; the live terminal and steer controls must be usable one-handed.
- **Status must not rely on hue alone.** Status (working / idle / blocked / done) is the core signal; it is already paired with position and pips, and should keep a non-color cue (shape, icon, or label) wherever it carries meaning.
