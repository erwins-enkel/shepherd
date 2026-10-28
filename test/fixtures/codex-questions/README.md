# Native Codex question evidence

Captured using codex-cli 0.165.0 in an isolated interactive PTY on 2026-10-28.
IDs and content are synthetic probe data. JSONL includes the tool calls and their native
reply records; the async AgentMessage duplicates the call and accepted is only an acknowledgement.

- Async: Shift+Left opens the queue; a choice digit submits immediately. Free text uses text,
  then Enter. Other is the last numbered option and opens a text field. Replies identify the
  call and original question index with questionItemId.
- Sync: choice digits submit and advance immediately. Other uses Down to None of the above,
  Tab to notes, text, Enter. Final function output maps answers by the tool's question IDs.
- Async Ctrl+] skip is local TUI state, absent from the rollout. A queue with mismatched counts
  cannot be reconstructed from historical calls alone. The adapter refuses ambiguous mappings.
- A running turn can finish without a native reply; task_complete is not answer evidence.
  New task_started replaces the old turn controls. Unknown screens use the terminal fallback.

Screens are cropped to native dialog controls. They deliberately exclude unrelated chat output,
paths, authentication details and private prompts.
