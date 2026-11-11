# devvm evaluation (2026-11-11)

**Question:** should Shepherd use [devvm](https://github.com/devvmhq/devvm), "one VM for every project", for its sessions?

**Verdict: no, don't adopt it.** Watch it, and borrow two ideas (below).

## What devvm is

- A Go CLI (MIT) that gives each project folder its own Lima VM, using QEMU on Linux and `vz` on macOS.
  - Each VM is a copy-on-write clone of a base image. Toolchains are shared read-only.
  - Default size is 4 CPUs, 8 GiB RAM and a 100 GiB sparse disk.
- The network has tiers: `open`, `internet`, `allowlist` (the default), `none`, plus `learn`, which records the hosts the VM uses and then locks to them.
  - The allowlist is enforced on the host: QEMU runs with `restrict=on` and its only way out is a `guestfwd` to a host-side proxy.
- Secrets reach the VM only as per-VM placeholders. The host proxy decrypts the TLS with a per-VM CA and swaps each placeholder for the real secret in one header.
- `.git/hooks` and `.git/config` are bind-mounted read-only through a user namespace. With `--clone`, the VM gets its own copy of the repo, and you pull its work back with `git fetch devvm`.
- **Maturity:**
  - Public since 2026-11-06, at v0.1.0 plus two rc releases.
  - 672 commits, 670 of them by one author (w3cj).
  - Tests look strong: about 91k lines of test code, fuzz and e2e runs in CI, and 90–100% coverage per package.
  - It already has open data and protection bugs: #36 (Claude's Edit tool emptied files on the 9p share), #37 (a bypass of git protection), #40 (shallow clones fail).

## Why not

1. **It captures Claude's login with a MITM proxy.**
   - `devvm agent login claude` intercepts Claude's token endpoint. The host then holds the real token and refreshes it on the VM's behalf.
   - This is the "external broker intercepting claude's auth" that `docs/sandbox-security.md` (R3) rules out as edging into prohibited third-party piloting of the account (audit R6). It also breaks our stance of running the unmodified CLI with subscription OAuth refresh.
   - devvm itself warns that a Claude Code release can break the capture.
   - **This alone rules it out as a session backend.**
2. **All VMs share one login, and any VM can replace it.** A hijacked VM could log every other VM into an account it chooses (devvm's own `safety/network.md`). That is worse than R3, where a token leaks but stays tied to our account.
3. **No API for a program to drive it.**
   - There is a CLI with `--no-input` and `--json` lists, but no `exec`/`run` command and no SDK. devvm says so itself.
   - Driving it means `devvm host` plus `ssh -F … -t claude`. Some commands still need a terminal.
4. **No clear path to Shepherd's host-loopback services.** Our MCP server, hooks and agent ingress listen on host loopback. The VM sets `NO_PROXY=127.0.0.1`, and the proxy refuses loopback addresses unless you add a rule for each one. Our `10.0.2.2` slirp ingress has no ready-made equivalent.
5. **Cost and correctness per session.**
   - A full VM per worktree, at 8 GiB by default, against bwrap's near-zero overhead.
   - On Linux the project folder is shared over 9p, which breaks SQLite WAL and writes through mmap, and file watchers have to poll.
   - In mount mode, a worktree's real `.git` sits outside the VM, so linked worktrees would probably need `--clone`. That adds a fetch step before we can see a session's diff. Not tested.
6. **It mostly duplicates what we have.**
   - `src/egress.ts`: an allowlist through slirp4netns, dnsmasq and nft.
   - The bwrap membrane, which already mounts the git store read-only: `gitStoreReadOnlyFlags` in `src/sandbox.ts` covers `config`, `hooks`, `worktrees` and more.
   - `src/safe-git.ts`.
   - Its one real gain is a kernel boundary, a VM rather than a single-uid namespace. It brings that together with problems 1–5.

## Worth borrowing

- **Swap the GitHub token in on the host, never place it in the session.** A small host proxy for the GitHub hosts would replace a placeholder with the real token, so `~/.config/gh` no longer has to be mounted into the membrane.
  - This closes half of R3 (the gh token) without touching Claude's auth, so the ToS problem in point 1 doesn't apply.
  - devvm also blocks REST calls that create deploy keys, SSH keys, runners and webhooks. It does not block GraphQL, so we would need to cover that too.
  - Cost: a per-spawn CA plus trusting it inside the membrane. That needs a design spike.
- **A `learn` mode for the egress allowlist.** Run unconfined on a repo while recording the DNS names used, then suggest them as allowlist entries. That would make it easier to turn on the autonomous profile for repos whose builds need registries (`bun install` fails under the autonomous profile today).

## Egress allowlist UX: what to copy

Today an autonomous session that hits a blocked host goes like this:

1. The agent gets a DNS failure with no reason attached.
2. `src/egress-watch.ts` records an `egress_drop` signal.
3. The operator sees a toast, "Blocked egress to {host}".
4. Allowing the host means typing it into the per-repo `egressExtraHosts` list in Settings.

devvm turns each block into an explanation and a suggested next step, both for the agent and for the human (`safety/network.md` §Inside the VM, §Logs, §Locking it).

| devvm                                                                                                                                                                                                                                                                                                                         | Shepherd today                                   | What to copy                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A blocked request gets a 403 naming the host, the reason and the exact `devvm network allow …` command                                                                                                                                                                                                                        | DNS failure, no reason                           | Tell the **agent**: a steer or hook note saying "egress blocked `X`; the operator must allow it", so it stops retrying or working around the block                          |
| In the VM, `devvm-why` lists recent blocks, and a note before each prompt flags a new one                                                                                                                                                                                                                                     | none                                             | Same channel as the row above                                                                                                                                               |
| `devvm network log --blocked` lists each blocked host with its count, when it was last blocked, and an `ALLOW WITH` column                                                                                                                                                                                                    | One toast per host, which disappears             | A per-repo **Blocked hosts** list built from the `egress_drop` signals (already stored), with counts and a one-click **Allow for this repo** that writes `egressExtraHosts` |
| `learn` mode with `lock`: run with open internet, then choose from a list which hosts to keep                                                                                                                                                                                                                                 | none                                             | **Learn from blocks**: stay confined, collect the drops over a run, then review them in that list. Safer than devvm's version, which opens the internet while it learns     |
| The `lock` picker pre-ticks only port 443 hosts of a short list of registries and vendors that only the vendor can publish under (`registry.npmjs.org`, `files.pythonhosted.org`, `crates.io`, `proxy.golang.org`, `api.anthropic.com`, …)                                                                                    | none                                             | Use the same split for one-click allow. A host on that list is one click, anything else needs a deliberate confirm                                                          |
| **Risky hosts** always start unticked: IP literals, `xn--` names, paste sites, file drops, tunnels (ngrok, trycloudflare), webhook.site/OAST, free hosting (`vercel.app`, `workers.dev`, `cloudfront.net`), chat bot endpoints, and domains where anyone can get a subdomain (`github.io`, `amazonaws.com`, `googleapis.com`) | `egressExtraHosts` accepts any dotted name       | Warn about them in the Settings editor and in the Allow button                                                                                                              |
| Each tool in the image has its own rules: a `node` toolchain allows npm, the `docker` layer allows the Docker registries                                                                                                                                                                                                      | `bun install` fails under the autonomous profile | Offer allowlist presets based on the repo's lockfiles (`bun.lock` → npm registry, `Cargo.lock` → crates.io, …)                                                              |
| Rules are an exact `host:port`, never a `*.` wildcard                                                                                                                                                                                                                                                                         | **Suffix match, every port** (see below)         | Tighten ours                                                                                                                                                                |

**A gap this turned up in our egress.**

- dnsmasq's `--server=/domain/` matches suffixes (`hostMatchesAllowlist`, `src/egress.ts`).
  - Allowing `github.io` therefore allows `evil.github.io`.
  - The default `github.com` entry also lets in `gist.github.com`, a paste site that devvm marks as risky. Pushing to github.com can already carry data out, so the real damage is small, but the gap exists.
- The nft rule `ip daddr @allowed accept` has no port limit, so an allowed IP is open on every port.
- Exact-match entries plus `tcp dport {443}` (with any other port opted into explicitly) would follow devvm's model.
  - Cost: re-testing the GitHub and Anthropic host lists, since some may depend on subdomains.
  - The rule allows IP addresses, not names, so it stays coarser than devvm's SNI check. That limit is already known.

**Doesn't transfer:** devvm's rules by method and path, and its GitHub REST denies (deploy keys, runners, webhooks). Both need TLS interception, which we'd only take on together with the host-side GitHub token swap above.

## Revisit if

devvm adds a driver API, lets Claude authenticate without a broker (for example per-VM setup tokens with no interception), and has a few months of releases from more than one maintainer.

## Sources

- devvm repo and docs (`docs/content/docs/`): `internals/lima.md`, `internals/network.md`, `internals/git-protection.md`, `using/coding-agents.md`, `using/clone.md`, `using/limits.md`, `safety/network.md`, `safety/attack-vectors.md`, `compared/_index.md`, and `internal/netpolicy/netpolicy.go`.
- Shepherd: `docs/sandbox-security.md`, `src/sandbox.ts`.
- Not verified: how long a VM takes to start, real RAM use, how many VMs run at once in practice, and PTY behaviour over ssh.
