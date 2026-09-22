---
name: shepherd-session-control
description: This skill should be used when Codex needs to inspect or, with explicit authorization, create and control sessions on a running Shepherd backend through its authenticated HTTP API. It provides a read-first workflow for Superpowers subagents, isolated development sessions, event/activity inspection, and safe token handling.
license: Complete terms in LICENSE.txt
---

# Shepherd session control

Use this skill for work that needs a running Shepherd backend as a development counterpart: inspect active sessions, follow activity, create an isolated implementation session, or perform an explicitly authorized session action.

## Security boundary

- Obtain the base URL from `SHEPHERD_SESSION_BASE_URL` or an approved local configuration path. Obtain the bearer from `SHEPHERD_SESSION_TOKEN`; never accept a token as a command-line argument, file content, issue text, prompt, or log output.
- Never print, persist, commit, paste, or transmit the bearer except in the HTTP `Authorization` header to the configured Shepherd origin. Redact authorization headers and response bodies that could contain credentials.
- Prefer a named, scoped access token with the minimum required scope. Use `read` for inspection. Require explicit parent-task authorization before `full`/write operations.
- Treat a token pasted into chat, a screenshot, or a terminal as exposed. Recommend revocation and replacement before using it.
- Do not access arbitrary origins, follow redirects, or send bearer headers across origins. Require HTTPS for remote origins; allow HTTP only for loopback or the repository's documented `.ts.net` policy.
- For live validation, use only an own temporary token and verify cleanup with HTTP 401. Do not reuse or revoke another operator's token.

## Read-first workflow

1. Resolve the Shepherd origin and token from the approved environment without displaying values.
2. Call `GET /api/sessions` and record only nonsecret IDs, names, statuses, profile/server identity, and timestamps.
3. For one selected session, use `GET /api/sessions/{id}`, `/activity`, `/usage`, `/diff`, or `/worktree` only when the parent task requires that view. Keep output bounded and redact prompts, tokens, passwords, and private paths unless explicitly needed.
4. For event-driven work, use the existing event endpoint/client and one connection per selected server. Reconnect with backoff; never start a second socket for the same session.
5. Before handing work to a Superpowers subagent, pass a bounded task, selected session ID, read/write scope, and cleanup requirement. Do not pass the bearer. The subagent inherits this skill and reads the environment itself.

## Write workflow

- Creating a session is a write action. Require explicit authorization in the current task and a clear prompt/repository/branch target. Use `POST /api/sessions` with the documented payload; never invent fields or server payloads.
- Reply, interrupt, archive, amendments, resume, rename, and other mutations require the same explicit authorization. Show the intended session ID and operation before executing when the parent workflow supports checkpoints.
- Assign every created session a unique run label and record it outside the bearer. On completion, archive only the session created by this run unless the user explicitly asks otherwise.
- Keep native/Xcode/UI operations serialized through the repository's shared `uitest-lock.sh`; backend HTTP calls do not replace that lock.

## Superpowers integration

When dispatched as a subagent, return a compact report with:

- server identity (redacted origin), selected session IDs, and read/write scope;
- observed status/activity and exact API routes used;
- mutations performed, if explicitly authorized;
- cleanup result and any unmet gate.

Do not implement product code from this skill unless the parent Superpowers plan assigns files and gives implementation authorization. Use the skill for backend coordination around the assigned worktree only.

## Repository references

Read `docs/external-task-api.md` before using a route. It defines authentication, scopes, session creation, inspection, event streaming, and mutation semantics. Read `docs/sandbox-security.md` before asking for a write scope or using a live token. Use the repository's existing client/fixtures where possible; do not duplicate payload models.
