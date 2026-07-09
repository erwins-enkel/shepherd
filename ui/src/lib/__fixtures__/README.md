# Test fixtures

## `claude-code-transcript.txt`

Raw PTY bytes captured verbatim from a real `claude` process (Claude Code v2.1.205,
100x30, `TERM=xterm-256color`), replayed through a real xterm parser by
`src/lib/promptPins.browser.test.ts`.

Both prompts were delivered exactly the way Shepherd delivers a steer — bracketed
paste (`ESC [ 200 ~ … ESC [ 201 ~`) followed by CR — and the session is long enough
that the first prompt's echo scrolled into the trimmed scrollback while the second
is still on the screen rows.

It also ends with a third line of text typed into the live input box and deliberately
never submitted. The box's own row starts with `❯` too, so that draft is what proves
the rule-frame guard rejects it structurally rather than by accident: delete the guard
and this fixture's test goes red.

It exists to pin down the one thing `promptPins.ts` assumes about the agent: that a
submitted prompt is rendered as a `❯ <text>` line at column 0. If Claude Code ever
changes that, the test fails loudly instead of the pinned-prompt bar going quietly
blank. Regenerate by capturing a fresh session's PTY output; identifying details
(account e-mail, org, paths) were scrubbed with same-length placeholders so every
column position and wrap point in the capture is preserved.
