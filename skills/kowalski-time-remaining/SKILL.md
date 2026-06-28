---
name: kowalski-time-remaining
description: Answer how much time is left on a Kowalski Instagram digest run. Trigger when the user asks "how much time is left", "how long until it stops", "what's the remaining timer", "how much longer", or similar while a Kowalski session may be active.
---

# Kowalski time remaining

Use this skill when the user asks how much time is left in a Kowalski digest
run.

Call:

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

If the active session id is unavailable, use the newest active Kowalski session
id you have in memory. If no session id is available, ask the user for status
context or call the no-argument print/status path only if another Kowalski
skill has already established a current session.

When `get_session_status` returns `digest_status: "running"`, compute:

```text
time_left = timer_remaining_ms
```

If `timer_remaining_ms` is missing, compute:

```text
time_left = max(0, timer_total_ms - timer_elapsed_ms)
```

Tell the user the time left in minutes and seconds. You may also include the
elapsed and total timer values briefly, for example:

```text
About 12m30s left. Elapsed is 7m30s of a 20m00s timer.
```

If `digest_status` is `"completed"` or `"stopped"`, say the timer is no longer
running and call `print_digest` if the user wants the result. If it is
`"failed"`, report the failure. If it is `"idle"`, say no digest timer is
currently running for that session.
