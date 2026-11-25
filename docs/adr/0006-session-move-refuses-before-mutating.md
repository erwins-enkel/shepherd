---
status: accepted
---

# A cross-machine session move runs as three roles and refuses before it changes anything

**Continue with…** can move a session to another connected Shepherd machine (#3793). The Shepherd that handles the request is the coordinator, and it runs the move as three roles, each in-process when the role is this Shepherd and over the machine client when it is another one. First the source, the session's own machine, prepares: it holds automatic resumes and steers, stops the agent, commits whatever it left uncommitted and pushes the work branch. Then the carried files (plan, uploads) are staged on the coordinator, the same way a create's attachments are. Last the target creates a new session as a `continuation` of that same branch, so an open pull request stays the same. The order puts every possible refusal ahead of any change. A source that refuses has touched nothing. If the target refuses or fails, the source resumes its agent, and nothing has moved. Only a target that reports the session started (or held until it has capacity, the work being pushed already) makes the source archive the original.

## Consequences

- No answer from the target undoes nothing, since the target may have started the session. The original stays stopped while the source holds automatic resumes and steers. That hold is in memory and time-bounded (10 minutes, `HANDOFF_HOLD_MS`), so a coordinator that dies mid-move cannot strand the session for good. Once the hold expires, automatic resumes and steers can revive the original while the target may be running the same branch, and a late `complete` no longer archives it. The operator should resolve a no-answer move by archiving the original or resuming it.
- The target create is a keyed dispatch (`move-<session>-<head commit>`), so a retried or re-checked move never starts the session twice.
- A carried file that cannot be fetched does not fail the move. The new agent's prompt names it instead.
- The source's half is a set of server-to-server routes (`/api/sessions/:id/handoff/{prepare,complete,abort}`). Any new step must keep the order: refusals first, then reversible preparation, then the archive.
- The coordinator logic lives in `src/remote-instances/move.ts`; the source's preparation is `SessionService.prepareHandoff`.
