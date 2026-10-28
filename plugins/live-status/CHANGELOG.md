# Changelog

## 0.5.2
- The band stacks as soon as a row of gauges would be too narrow, instead of only below 520px, so a fourth gauge no longer leaves the labels running into the percentages.
- A gauge label is fitted to the room left beside its percentage, and gives way to the CRITICAL / HIGH word when the column is very narrow.

## 0.5.1
- RTK per project: the band gauge shows the savings of the folder you work in (`rtk gain --project`), and the panel lists this project and all projects separately.

## 0.5.0
- RTK monitoring when RTK is installed: a green `RTK SAVED` gauge in the band and a token-savings section in the panel, read from `rtk gain` every 60 s. Not installed: nothing shown.

## 0.4.1
- Zero tokens: removed the `task` tool the mod used to register (its definition rode along on every request). Task progress now reads the todo list Claude already keeps (`TodoWrite`), observed without changing the call.

## 0.4.0
- Every session card shows the real progress of its task (`3/6 · 50%`), published by that session's own `task` reports. Sessions that report nothing show an empty bar and a note instead of a made-up percentage.
- Session cards no longer draw a freshness bar.
- Lighter on CPU and memory: adaptive polling (5 s when something moves, 15 s idle), file reads cached by modification time, a slow redraw clock for the panel, fewer retained runs, and no shimmer on the band's bars.

## 0.3.4
- Side panel is static: plain progress bars, no sweeping or shimmer animation, so it stays light. (The band above the prompt keeps its motion while a turn runs.)
- Session bars show how fresh the last activity is.

## 0.3.3
- Sessions idle for more than 30 minutes are hidden. A session that went idle more recently (most likely waiting for you) stays, marked `NEEDS YOU`.

## 0.3.2
- Finished subagents are collapsed by default; opening them shows the latest eight.

## 0.3.1
- Side panel split into two sections, Sessions and Subagents, each with an overview progress bar.
- Every session card has a progress bar: a sweep while it works, a draining bar while it is idle.

## 0.3.0
- Sessions panel: every live Claude Code session on the machine, with status and last activity; the band shows the count.

## 0.2.0
- Responsive card: stacks when narrow; subagents listed inline when the panel has no room.
- `/monitor` toggles the band and the agents panel together (`on` / `off` to force).
- Panel opens at session start.
- Realtime: usage re-read every 5 s mid-turn and every 15 s idle.

## 0.1.0
- Model, effort, context, 5H/7D limits, cost, task bar (`mcp__live-status__task`) and the agents panel.
