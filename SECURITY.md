# Security Policy

Shepherd is a **self-hosted** tool that spawns and steers real interactive coding-agent
sessions in isolated git worktrees, and executes untrusted, agent-generated code on the
host that runs it. Its security model — the sandbox/egress isolation the agents run
inside — is documented in [`docs/sandbox-security.md`](docs/sandbox-security.md). Because
an operator points Shepherd at their own machine and their own repos, the trust boundary
is unusually load-bearing, and we take reports seriously.

## Supported versions

Shepherd ships as a rolling release; only the **latest release** on `main` receives
security fixes. Please reproduce against the newest version before reporting.

## Reporting a vulnerability

**Please do not open a public issue, PR, or Discussion for a security vulnerability**, and
do not disclose it publicly until it has been fixed and a release is available.

Report privately through **GitHub Private Vulnerability Reporting**:

> Repo **Security** tab → **Report a vulnerability** → open a private advisory.

This keeps the report, the discussion, and any fix coordination confidential until a patch
ships. If private reporting is unavailable to you, contact the maintainers privately (e.g.
a direct message) rather than filing anything public, and we will open an advisory on your
behalf.

Please include, as far as you can:

- affected version / commit and platform,
- a minimal reproduction or proof-of-concept,
- the impact you believe it has (e.g. sandbox escape, host RCE, secret disclosure,
  auth bypass), and
- any suggested remediation.

## What to expect

- **Acknowledgement** within a few days of your report.
- An initial assessment (severity + whether we can reproduce) shortly after.
- Coordinated disclosure: we'll agree a timeline with you, fix in a private advisory
  branch, release, and then publish the advisory crediting you unless you prefer to remain
  anonymous.

## Scope

In scope: the Shepherd server (`src/`), the UI (`ui/`), the browser extension
(`extension/`), the sandbox/egress isolation, the operator auth layer, and the CI/release
automation under `.github/`.

Out of scope: vulnerabilities in third-party coding agents (`claude`, `codex`) themselves,
issues that require an already-compromised host or a misconfiguration explicitly warned
against in the docs (e.g. binding the server to `0.0.0.0` on an untrusted network), and
findings against a fork's modifications rather than this repository.

Thank you for helping keep Shepherd and its operators safe.
