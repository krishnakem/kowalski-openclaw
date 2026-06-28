---
name: kowalski-timer
description: Change the requested Kowalski Instagram digest timer. Trigger when the user says things like "change the timer to 20 minutes", "make the run 15 minutes", "use 30 minutes instead", or "adjust the Kowalski duration". This skill updates pending and live run duration; during a live run stories keeps its original cap and changed time goes to feed/posts.
---

# Kowalski timer changes

Use this skill when the user wants to change the duration of a Kowalski
Instagram digest run.

## Behavior

If `start_session` has not been called yet, do not call a tool. Use the newest
duration when the digest is started:

```json
{ "name": "start_session", "arguments": { "duration_minutes": 20 } }
```

If a Kowalski session exists, call:

```json
{ "name": "update_timer",
  "arguments": { "session_id": "…", "duration_minutes": 20 } }
```

When `update_timer` returns `status: "timer_updated"`, tell the user the new
duration and split. With both phases enabled, Kowalski uses 30% for stories
and 70% for feed/posts before the run starts. During a live run, stories keeps
its original cap and the changed time is applied to feed/posts.

If the response includes `stop_requested: true`, elapsed time already meets or
exceeds the new timer. Tell the user the run is stopping and will finalize a
partial digest if captures exist.

Do not claim the timer changed unless the tool returned `status:
"timer_updated"` or the digest has not been started yet and you are only
changing the duration you will use for the future `start_session` call.
