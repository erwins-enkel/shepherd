# PreToolUse hook for AskUserQuestion / ExitPlanMode — finding

_Spike report — 2026-10-25, Claude Code 2.1.310. Issue #2779 (follow-up to `claude-code-mods.md`
§3.1 and §7 item 1)._

## Verdict

A plain settings `PreToolUse` hook (no mods) with matcher `AskUserQuestion|ExitPlanMode` delivers:

- **which dialog is open, and its content** — the questions/options of `AskUserQuestion`, the plan
  text of `ExitPlanMode` — as typed data;
- **an earlier block edge** — PreToolUse lands ~6 s before `Notification(permission_prompt)` (2 of 2
  runs, both tools: 6.02 s and 6.05 s).

It does **not** replace option scraping everywhere:

- `ExitPlanMode`'s `tool_input` carries no options; the dialog's choices ("Yes, and use auto mode" /
  "Yes, manually approve edits" / "Tell Claude what to change") are Claude Code's own UI and vary by
  mode, so the numbered `BlockOption`s still come from the PTY.
- `AskUserQuestion`'s screen adds two rows the payload lacks ("Type something." for Other, "Chat
  about this"), so the payload is not a 1:1 copy of the menu either; #3165 answers it with key
  sequences instead of `BlockOption`s.
- Permission prompts and every other menu have no such hook payload.
- Codex has neither tool: detection there stays on the PTY regex.

So the regex (`classifyBlocked`) stays the fallback and the option source. What the hook now buys
(implemented with this finding):

1. `PreToolUse(AskUserQuestion)` → `block.ask` (already shipped in #3165).
2. `PreToolUse(ExitPlanMode)` → `block.plan` (plan text, capped at 32 000 chars), shown in the web
   terminal as a "plan waiting for approval" strip. Approval still happens in the terminal.
3. Either PreToolUse arms the hook-driven classify (the `hookAwaitingInput` marker the
   Notification already arms) ~6 s sooner. For up to 10 s, until the dialog reads as a `menu`, an
   `awaiting-input` reading is withheld: the hook can land before the dialog paints, and an
   announced `awaiting-input` is steerable — autopilot's Enter would answer the dialog.
4. While a hooked dialog is pending, a numbered run without dialog chrome (a dialog caught
   mid-paint, #2281's demotion) is promoted back to `menu`: the hook is the chrome evidence.

**Cost:** one extra HTTP POST per call of these two tools only (both block on a human anyway). The
route answers 200 with an empty body, so the dialog renders unchanged.

## Method

tmux, `claude --settings <file> --model sonnet --permission-mode plan` in a throwaway git repo;
every hook was a `command` hook writing its stdin to a timestamped file. Hooked: PreToolUse and
PostToolUse (matcher `AskUserQuestion|ExitPlanMode`), PostToolUseFailure and Notification (`*`).
Prompts asked for one AskUserQuestion with two questions (single + multiSelect), then for
ExitPlanMode twice (rejected once, approved once).

## Payloads

Sanitized: `transcript_path`, `cwd` and `scratchpad_dir` removed; ids kept.

### PreToolUse(AskUserQuestion)

```json
{
  "session_id": "7adb72a1-72c6-4d9c-88f0-8c7918815e46",
  "prompt_id": "87fe2dca-ec55-4be2-811d-05eefab6482f",
  "permission_mode": "plan",
  "effort": { "level": "medium" },
  "hook_event_name": "PreToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [
      {
        "question": "Pick a color?",
        "header": "Color",
        "options": [
          { "label": "Red", "description": "Warm, bold color" },
          { "label": "Blue", "description": "Cool, calm color" },
          { "label": "Green", "description": "Natural, fresh color" }
        ],
        "multiSelect": false
      },
      {
        "question": "Which pets?",
        "header": "Pets",
        "options": [
          { "label": "Cat", "description": "Independent, quiet pet" },
          { "label": "Dog", "description": "Loyal, active pet" }
        ],
        "multiSelect": true
      }
    ]
  },
  "tool_use_id": "toolu_017k7c3DuMggAvg6orict7G2"
}
```

The rendered dialog for question 1 (options 4 and 5 are not in the payload):

```text
←  ☐ Color  ☐ Pets  ✔ Submit  →
Pick a color?
❯ 1. Red
     Warm, bold color
  2. Blue
     Cool, calm color
  3. Green
     Natural, fresh color
  4. Type something.
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

### Notification (6.02 s later)

```json
{
  "session_id": "7adb72a1-72c6-4d9c-88f0-8c7918815e46",
  "prompt_id": "87fe2dca-ec55-4be2-811d-05eefab6482f",
  "hook_event_name": "Notification",
  "message": "Claude needs your permission",
  "notification_type": "permission_prompt"
}
```

### PostToolUse(AskUserQuestion)

`tool_input` and `tool_response` both echo the questions plus `answers` (question → label; multi
joins labels) and `annotations`:

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "AskUserQuestion",
  "tool_response": {
    "questions": ["…same as tool_input…"],
    "answers": { "Pick a color?": "Red", "Which pets?": "Cat" },
    "annotations": {}
  },
  "tool_use_id": "toolu_017k7c3DuMggAvg6orict7G2",
  "duration_ms": 1
}
```

### PreToolUse(ExitPlanMode)

```json
{
  "session_id": "7adb72a1-72c6-4d9c-88f0-8c7918815e46",
  "prompt_id": "e6260e6f-d59e-4d1c-8318-00c27bf5bac1",
  "permission_mode": "plan",
  "effort": { "level": "medium" },
  "hook_event_name": "PreToolUse",
  "tool_name": "ExitPlanMode",
  "tool_input": {
    "plan": "Step 1: create a.txt\nStep 2: create b.txt\nStep 3: create c.txt\n",
    "planFilePath": "~/.claude/plans/this-is-a-hook-golden-swing.md"
  },
  "tool_use_id": "toolu_01UjzafXpknM7QcAf4GRPftp"
}
```

Followed 6.05 s later by `Notification` with `message: "Claude Code needs your approval for the
plan"`, `notification_type: "permission_prompt"`.

### PostToolUse(ExitPlanMode) — approved only

```json
{
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "ExitPlanMode",
  "tool_input": {},
  "tool_response": {
    "plan": "Step 1: create a.txt\nStep 2: create b.txt\nStep 3: create c.txt\n",
    "isAgent": false,
    "filePath": "~/.claude/plans/this-is-a-hook-golden-swing.md"
  },
  "tool_use_id": "toolu_01UjzafXpknM7QcAf4GRPftp",
  "duration_ms": 1
}
```

**Rejecting** ("Tell Claude what to change" + feedback) sent **no** PostToolUse and no
PostToolUseFailure. The plan therefore closes the way an Esc-cancelled AskUserQuestion does: when
the block carrying it clears, or on `Stop` / `SessionEnd`.

## Consequences for the implementation

- `planFilePath` is a host path with no client use; it is dropped at validation.
- The plan is untrusted agent text: rendered as plain text, never Markdown/HTML.
- Live sessions pick up the wider matcher on their next spawn or resume.
