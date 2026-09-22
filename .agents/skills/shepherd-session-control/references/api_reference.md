# Shepherd backend API quick reference

The authoritative reference is `docs/external-task-api.md` in the Shepherd repository. Use it before any request.

## Authentication

Use `Authorization: Bearer $SHEPHERD_SESSION_TOKEN` only to the configured Shepherd origin. Named access tokens are preferred because their scope and revocation are explicit. Read scope covers session inspection; session creation and control require the scope documented by the server.

## Read routes

- `GET /api/sessions`
- `GET /api/sessions/{id}`
- `GET /api/sessions/{id}/activity`
- `GET /api/sessions/{id}/usage`
- `GET /api/sessions/{id}/diff`
- `GET /api/sessions/{id}/worktree`

Bound output and redact prompts, credentials, private paths, and bearer material.

## Mutation routes

Session creation, reply, interrupt, resume, rename, amendments, and archive are documented in `docs/external-task-api.md`. Execute them only after explicit authorization in the current task and only for a session owned by the current run.

## Cleanup

A temporary token is considered cleaned up only after its own authenticated request returns HTTP 401. Do not infer revocation from a successful DELETE alone.
