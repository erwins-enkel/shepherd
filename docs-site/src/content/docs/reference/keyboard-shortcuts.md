---
title: Keyboard shortcuts
description: Drive the Shepherd dashboard from the keyboard — the command bar, session switching, and terminal keys.
---

Shepherd is built to drive from the keyboard. These shortcuts are **desktop-only** and are suppressed while a modal or overlay is open. The plain-key shortcuts fire only when the dashboard body has focus (not while you are typing in a field); the command bar and the Alt / Option switchers work **even while the terminal is focused**.

## Command bar

| Keys | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Open the command bar — a quick-switcher over your sessions, repositories, and herd lenses. Fires even while an input or the terminal is focused. Type to filter, `↑` / `↓` to move, `Enter` to jump, `Esc` to close. |

The command bar also carries verbs beyond navigation — including **Next needs you**, which jumps to the next session waiting on your reply (offered whenever another session is waiting). Type part of a verb's name to surface it.

## Session & herd navigation

These fire when the dashboard body has focus — not while typing in a field.

| Keys | Action |
| --- | --- |
| `j` / `↓` | Select the next session |
| `k` / `↑` | Select the previous session |
| `1`–`9` | Select the Nth session |
| `n` | Open New Task |
| `r` | Open the Repos / backlog view |
| `Enter` | Return keyboard focus to the terminal |

## Switch sessions while the terminal is focused

The Alt combos work even while the terminal owns the keyboard, so you can move around the herd without leaving the active session. On macOS the modifier is ⌥ Option, and matching is on the physical key (Option changes the character that would be typed).

| Keys | Action |
| --- | --- |
| `Alt+J` / `Alt+↓` | Next session |
| `Alt+K` / `Alt+↑` | Previous session |
| `Alt+]` / `Alt+Tab` | Next session |
| `Alt+[` / `Alt+Shift+Tab` | Previous session |
| `Alt+1`–`Alt+9` | Select the Nth session |

The `Alt+Tab` / `Alt+Shift+Tab` variants work on macOS; on Windows and Linux the OS window switcher captures `Alt+Tab` before the app sees it, so use `Alt+]` / `Alt+[` there.

## Terminal

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+C` | Copy the terminal selection (plain `Ctrl+C` sends an interrupt to the agent) |

## New Task

Inside the New Task prompt you can switch repositories without leaving the field.

| Keys | Action |
| --- | --- |
| `Alt+[` / `Alt+]` | Previous / next repository |
| `Alt+1`–`Alt+3` | Jump to the Nth recent repository |
| `Alt+R` | Open the repository picker |
| `⌘Enter` / `Ctrl+Enter` | Submit the task (plain `Enter` inserts a newline) |
