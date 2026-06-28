---
name: instagram-digest
description: Run the Kowalski Instagram digest pipeline — capture stories and feed, extract posts, and produce a markdown digest summarizing what the user would see on their Instagram home if they opened it now. Trigger on digest-style asks like "what's happening on my feed", "what did I miss on Instagram today", "run the feed digest", "summarize my IG", "catch me up on stories", or "kowalski run". Do NOT trigger on generic "open Instagram" or "browse Instagram" requests — this skill is for producing a digest, not for interactive browsing.
---

# Instagram digest playbook

This skill orchestrates the Kowalski OpenClaw plugin to capture the user's
Instagram home (stories + feed) and return a markdown digest. It is a
blocking, multi-tool workflow whose capture length is chosen by the user at
the start. The default backend is OpenClaw's configured provider, so cost
depends on the user's gateway/provider configuration.

Kowalski requires a vision-capable model. If screenshot understanding fails,
tell the user to configure `agents.defaults.imageModel` to a model with image
input.

Before starting a digest, ask the user how many minutes they want the run to
be unless they already specified a duration. Pass that value as
`duration_minutes` to `start_session`. When both phases run, Kowalski splits
the requested time 30/70: stories get 30%, and feed/posts get 70%.

The plugin exposes eleven tools: `start_session`, `login`,
`submit_verification_code`, `update_timer`, `run_digest`,
`get_session_status`, `print_digest`, `reset_memory`, `reset_all`,
`stop_run`, `end_session`.

Manual `run_digest` calls block until completion and return the
display-ready digest markdown directly in the TUI after writing the JSON/PDF
artifacts. The normal `start_session` / login / 2FA workflow starts the same
pipeline in the background. After it starts, save the `session_id`; when the
user asks for status or results, call `get_session_status` or `print_digest`.
Do not create OpenClaw cron/scheduled follow-up turns unless the plugin config
explicitly enables `enableScheduledPolling` and the gateway has a delivery
channel configured.

---

## When to use

Trigger when the user asks for a digest of their Instagram activity:

- "What's happening on my feed today?"
- "What did I miss on Instagram?"
- "Run the feed digest."
- "Summarize my IG today."
- "Catch me up on stories."
- "Kowalski run."
- "Brief me on Instagram."

Do NOT trigger on:

- "Open Instagram" / "Browse Instagram" — these imply interactive use.
- "Post to Instagram" / "Reply to a DM" — out of scope.
- Generic questions about Instagram the product.

---

## Canonical sequence for a digest request

Follow these steps exactly. `start_session` is now the workflow entrypoint:
it creates the session, checks cookies, starts login if needed, and starts
`run_digest` automatically once Instagram login is verified.

### 1. `start_session`

Before calling, ask how many minutes the user wants the run to be unless they
already gave a duration. Then tell the user something like:

_"Kicking off a 20-minute digest now — Kowalski will split that as
6 minutes for stories and 14 minutes for feed/posts. Cost depends on
your configured OpenClaw provider. The run goes in the background once
login is verified. Say "stop" any time to abort, or ask me "is it
done?" and I'll check."_

Then call with the requested duration and optional phases (see Parameter
notes).

```json
{ "name": "start_session", "arguments": { "duration_minutes": 20 } }
```

`start_session` can return any of these shapes:

```json
{ "status": "started", "session_id": "…", "triggered_by": "start_session", "message": "…" }
```

Digest has started. Tell the user the run is in flight and save the
`session_id` for status/stop calls.

```json
{ "status": "pending_credentials", "session_id": "…", "message": "…" }
```

No Instagram credentials are available in the gateway environment. Do not ask
for the Instagram username/password in chat and do not pass credentials through
tool parameters. Tell the user to set `IG_USERNAME` and `IG_PASSWORD` outside
the LLM/tool-call path, restart the OpenClaw gateway, then run `start_session`
again. If they have an existing Instagram cookie, they can instead set
`IG_SESSIONID` or `INSTAGRAM_SESSIONID`.

```json
{ "name": "login",
  "arguments": { "session_id": "…" } }
```

`login` automatically resumes the workflow. If credentials are accepted
and no challenge appears, it returns `status: "started"` and the digest is
already running.

```json
{ "status": "pending_2fa", "session_id": "…", "login_id": "…", "message": "…" }
```

Instagram asked for a 2FA code. Ask the user for the 6-digit code from
their authenticator app or SMS, then call:

```json
{ "name": "submit_verification_code",
  "arguments": { "login_id": "…", "code": "123456" } }
```

If verification succeeds, `submit_verification_code` automatically starts
the digest and returns `status: "started"`. Treat the returned
`session_id` as authoritative: replace any older pending-login or
pending-2FA session ID in memory, and use this newest `session_id` for
status, stop, cron, and `print_digest` calls. If it returns `pending_2fa`
again, the code was rejected or expired; ask for a fresh code and call the
same tool again.

```json
{ "status": "pending_device_approval", "session_id": "…", "login_id": "…",
  "device_description": "…", "message": "…" }
```

Instagram sent a login-approval notification to another device. Tell the
user which device Instagram named, ask them to approve it, then call:

```json
{ "name": "submit_verification_code",
  "arguments": { "login_id": "…", "code": null } }
```

If approval succeeds, `submit_verification_code` automatically starts the
digest. If it returns `pending_device_approval` again, ask whether the
notification appeared and call the same tool with `code: null` for another
120-second poll.

```json
{ "status": "login_failed_needs_manual", "reason": "…", "message": "…" }
```

Relay the message. Ask the user to approve or clear the challenge from
the Instagram app on their phone, then retry later.

```json
{ "status": "context_destroyed", "login_id": "…", "message": "…" }
```

The pending-login browser was closed before the code arrived. Re-run
`login` with the same `session_id`; Instagram may not ask for 2FA again
if cookies partially persisted.

### 2. While The Run Is Active

After a `status: "started"` response, tell the user the digest is running in
the background and save the returned `session_id` as the current active digest
session, replacing any older login/session IDs.

Do not schedule a silent automatic print check by default. Newer OpenClaw
gateways require a configured delivery channel for scheduled agent turns, so
unconfigured cron checks can surface as user-visible agent failures. When the
user asks "is it done?", "how is it going?", or "print it", use:

```json
{ "name": "print_digest", "arguments": { "session_id": "…" } }
```

If `print_digest` returns display-ready markdown, immediately show that
markdown to the user verbatim in the TUI. This is the completion signal for
the whole workflow; do not summarize it and do not stay silent. If it returns
JSON with `status: "pending"` and `silent: true`, tell the user the digest is
still running only if they directly asked; otherwise stay silent and wait for
the next explicit user request.

**Answering "how much time is left?" mid-run.** Read the most recent
progress line from the TUI log pane scrollback and report the numbers
verbatim. You can also call `get_session_status` to read
`digest_elapsed_ms`.

**Answering "is it done?" / "how's the run going?".** Call:

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

The response includes `digest_status`:

- `"running"` — still in flight. Report elapsed time, remind user
  they can say "show it now" to stop the run and print whatever has
  already been captured.
- `"completed"` — digest is ready. Immediately call `print_digest` with
  the returned `session_id` and `digest_record_id`, then present the
  returned markdown to the user verbatim.
- `"stopped"` — user-stop aborted it partway. Immediately call
  `print_digest` with the returned `session_id` and `digest_record_id`,
  then present the returned partial markdown to the user verbatim.
- `"failed"` — run errored out. `digest_error` explains why.
- `"idle"` — no digest has been started on this session yet.

### 2.a. Timer Changes

If the user changes the timer before `start_session` has been called, do not
call a tool yet. Use the newest duration when you call `start_session`.

If `start_session` has returned a `session_id`, call:

```json
{ "name": "update_timer",
  "arguments": { "session_id": "…", "duration_minutes": 25 } }
```

When `update_timer` returns `status: "timer_updated"`, tell the user the new
split and keep using the same `session_id`. If the digest is already running,
stories keeps its original cap for that run and the changed time is applied to
feed/posts. If the response has `stop_requested: true`, elapsed time already
met the new timer, so tell the user the run is stopping and will finalize a
partial digest if captures exist.

### 3. Present The Result

When `get_session_status` returns `digest_status: "completed"` or
`"stopped"`, call:

```json
{ "name": "print_digest",
  "arguments": { "session_id": "…", "record_id": "…" } }
```

`print_digest` is safe to call before completion. While the digest is still
running, it returns JSON with `status: "pending"` and `silent: true`; do not
show that pending payload to the user. Once ready, it returns a plain text
tool result containing the digest markdown exactly as it should appear in
chat/TUI, including emoji, followed by artifact paths. Show the ready result
to the user verbatim. If the session id is unavailable but the user asks for
the latest generated digest, call `print_digest` with `{}`; it prints the
newest ready in-memory digest or the newest saved analysis record. Three
artifacts get written every run:

- JSON record — `~/.kowalski/output/analysis_records/<id>.json`
- Text-only PDF — `~/Downloads/kowalski-digest-<id>.pdf` (or whatever
  `downloadsDir` is set to in plugin config)
- Run screenshots — `~/.kowalski/output/runs/<id>/` (referenced by the
  JSON `images` array)

Point the user at the PDF path in your reply — it's the easiest thing
for them to open or share.

`print_digest` auto-ends the session after it returns the completed/stopped
digest, so do not call `end_session` after a successful print. Failed
sessions remain available for inspection or explicit cleanup.

---

## Non-digest paths

### "Forget what you learned last week" / "Reset Kowalski's memory"

```json
{ "name": "reset_memory", "arguments": {} }
```

Deletes the cross-run session memory so the next run starts from a clean
slate. Idempotent. Login cookies, analysis records, and plugin config
are untouched.

### "Wipe everything" / "Factory reset" / "Reset all my data"

```json
{ "name": "reset_all", "arguments": {} }
```

First call returns a dry-run preview — exactly what paths will be wiped
and how many active sessions / pending-login browsers will be torn down.
Show the preview to the user, confirm they want to proceed, then call
again with `confirm: true`:

```json
{ "name": "reset_all", "arguments": { "confirm": true } }
```

This wipes the browser profile (login cookies go with it), the scratch
dir (session memory, stop markers, run temp), the output dir (every
`analysis_records/<id>.json` plus every run's screenshots). It does NOT delete
digest PDFs already written to Downloads, and it does NOT clear OpenClaw plugin
config. After resetting, the next `start_session` will ask for Instagram login
if the browser profile no longer has a valid cookie.

Always ask before calling with `confirm: true`. If the user asks to
"reset everything" or "wipe Kowalski", do the dry-run first, show them
the preview, and wait for explicit confirmation before the real call.

### "Is the digest done?" / "How's the run going?"

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

Returns `digest_status` (`running` | `completed` | `stopped` | `failed`
| `idle`), last phase, recent ~20 pipeline events, and — when the
digest is done — `digest_ready: true` plus the `digest_record_id` and
`next_tool` payload for `print_digest`. Auto-started runs from
`start_session`, `login`, and `submit_verification_code` are non-blocking,
so this tool can be called at any time during those runs and live polling
works normally.

### "Show it now" / "Give me what you have" / "Stop the run" / "I've seen enough"

If the user asks to see the digest now, asks for whatever is already done,
or says they have seen enough during an auto-started background run, treat it
as a graceful stop-and-print request. Call `stop_run` immediately. Because
auto-started runs are non-blocking, this tool dispatches instantly — no
gateway queueing. If you have the session_id, pass it. If the user asks to
stop/print-now and you do not have a reliable session_id, call `stop_run`
with `{}`; it is also a global stop switch and writes the plugin-level
marker. Do not poll status first just to rediscover a session id when the
user asked to stop or print now.

The run will finalize within ~30 seconds and produce a partial digest
with whatever was captured so far. The digest will have `aborted: true`
and `abortReason: user-stop` in its metadata.

Stopping means "stop collecting more Instagram content", not "discard the
digest". Do not create a new cron watcher by default. The TUI and PDF should
still receive the partial digest from whatever has already been captured once
you explicitly call `print_digest`.

```json
{ "name": "stop_run", "arguments": { "session_id": "…" } }
```

```json
{ "name": "stop_run", "arguments": {} }
```

After `stop_run` returns, poll `get_session_status`; when
`digest_status` becomes `"stopped"` or `"completed"`, immediately call
`print_digest` with the returned `session_id` and `digest_record_id`, then
present that markdown to the user verbatim. If it is `"stopped"`, call it a
partial digest. If you stopped globally because the session id was
missing/stale, tell the user the stop marker was sent and wait briefly for
finalization before printing.

If a previously configured print check fires after a stop, let it call
`print_digest`; if the partial digest is ready, print it in the TUI. If it is
still pending, do not schedule another check unless scheduled polling was
explicitly enabled and the gateway has a delivery channel.

**Manual escape hatch (rarely needed now).** The plugin also watches
for a file marker at `~/.kowalski/scratch/STOP_REQUESTED`, polled on
RunManager's own 3s interval. A user can `touch` that file from any
terminal to force a stop without going through the agent at all —
handy if the agent itself is wedged or the TUI is unresponsive. The
`stop_run` tool writes this marker anyway as a belt-and-suspenders
measure, so calling the tool is always the first-class path.

Note: `end_session` does NOT interrupt a running digest — use
`stop_run` for mid-run aborts.

---

## Parameter notes

- **`start_session`** takes required `{ duration_minutes: number }` and optional
  `{ phases: ("stories" | "feed")[] }`. Default phases are
  `["stories", "feed"]`.
  - With both phases, the duration is split 30/70:
    stories get 30%, feed/posts get 70%.
  - With only one phase, that phase gets the full requested duration.
  - "Just feed" / "skip stories" → `phases: ["feed"]`
  - "Just stories" / "only stories" → `phases: ["stories"]`
- **`update_timer`** takes `{ session_id: string, duration_minutes: number }`.
  Use it after a session exists. If capture is already running, stories keeps
  its original cap and the changed time is applied to feed/posts.
- **Most other tools** take `{ session_id: string }`.
  Exceptions: `stop_run` may take `{ session_id?: string }` or `{}` as
  a global stop switch, and `reset_all` takes optional `{ confirm: boolean }`.
  `submit_verification_code` also takes
  `{ login_id: string, code?: string | null }` — `login_id` comes from
  a prior `login` pending response.

---

## Cost + duration expectations

- **Run length:** ask the user for the total minutes before calling
  `start_session`.
- **Default split:** stories phase 30%, feed/posts phase 70%.
- **Cost:** depends on duration, captures, and the configured OpenClaw provider.

Always mention the requested duration, split, and provider-cost caveat before
calling `start_session` so the user can abort upfront if the cost or time isn't
acceptable.

---

## Failure modes to handle gracefully

| Trigger | What happened | How to respond |
| --- | --- | --- |
| `start_session` returns `pending_credentials` | Persistent profile has no valid cookie, and no env credentials/session cookie are available. | Tell the user to set `IG_USERNAME` + `IG_PASSWORD`, or `IG_SESSIONID` / `INSTAGRAM_SESSIONID`, outside chat and restart the gateway. Do not collect passwords in chat or tool params. |
| `start_session` / `login` / `submit_verification_code` returns `status: "started"` | Login was already valid or has just been verified. | The digest is already running. Tell the user it is in flight and save the `session_id`. Do not schedule cron checks by default. |
| `login` returns `pending_credentials` | No env credentials are available after an explicit login retry. | Tell the user to set `IG_USERNAME` + `IG_PASSWORD`, or `IG_SESSIONID` / `INSTAGRAM_SESSIONID`, outside chat and restart the gateway. Do not collect passwords in chat or tool params. |
| `login` returns `login_failed_needs_manual` | Instagram showed a challenge the automated login cannot clear headlessly. | Relay the message, ask the user to approve or clear the challenge in the Instagram app on their phone, then retry login later. |
| `login` returns `pending_2fa` | Agentic flow hit a 2FA screen. | Ask the user for their code, call `submit_verification_code` with it. Do NOT guess the code. |
| `login` returns `pending_device_approval` | Agentic flow hit a device-push challenge. | Tell the user which device IG pinged (from `device_description`), then call `submit_verification_code` with `code: null` after they say they've approved it. |
| `submit_verification_code` returns `pending_2fa` again | Code was rejected. | Ask for a fresh code (the previous one may have timed out). |
| `submit_verification_code` returns `still pending` for device approval | User hasn't approved yet. | Ask if they saw the notification and call again with `code: null`. |
| `submit_verification_code` returns `context_destroyed` | The pending-login browser was closed before the code was submitted (stale entry, Chromium crash, or out-of-band close). | Re-run `login` from scratch. The earlier attempt may have persisted enough cookies that Instagram skips 2FA the second time. |
| `run_digest` error contains `"OFFLINE"` | Offline watchdog or a real network-layer model/browser error tripped. | Suggest retrying. The partial record is still on disk under `analysis_records/<id>.json` with `aborted: true, abortReason: offline`. |
| Tool error says `Bundled Chromium is missing` | The plugin-local Playwright browser was not installed or was deleted. | Tell the user to run `npm run setup:browser` in the kowalski-openclaw plugin directory, then retry. Do not suggest installing system Chrome. |
| `run_digest` error mentions `"timed out"` / the header mentions a stories or feed/posts timeout | A phase hit its user-derived hard cap. The digest still runs with partial captures; the record has `aborted: true` and `abortReason: timeout-stories` or `timeout-feed`. | Offer to show the partial digest — it's real, just cut short on that phase. |
| `run_digest` returns "another run already in progress" | The previous run is still holding the RunManager singleton. | Call `get_session_status` to see what's happening; if stale or no reliable session id exists, call `stop_run` with `{}` and wait briefly before retrying. |
| `stop_run` says it used the global stop marker because session_id was missing/stale | The session registry entry was gone, but the singleton runner may still be active. | Treat this as a successful stop request. Check status or print explicitly when the user asks for the partial digest. |
| `stop_run` returns successfully but the digest takes longer than 30 s to arrive | Normal — the stop marker is polled every ~3 s, and the agent needs to finish its current step. | Let it finalize; use `get_session_status` or `print_digest` on explicit user request. |

---

## Don'ts

- **Don't call `login` immediately after `start_session` returns
  `status: "started"`.** The digest is already running.
- **Don't autonomously schedule cron/status loops by default.** Newer
  OpenClaw gateways require a configured delivery channel for scheduled agent
  turns. Use explicit `get_session_status` / `print_digest` calls when the
  user asks, unless `enableScheduledPolling` is configured and channel
  delivery is known to work.
- **Don't call `run_digest` after a successful `start_session`, `login`,
  or `submit_verification_code` response.** Those tools now start the
  digest automatically when auth is verified. `run_digest` is only a
  manual override for an already-created session; when called manually it
  waits for completion and prints the digest itself.
- **Don't call manual `run_digest` if the user needs mid-run stop/status.**
  Manual `run_digest` blocks until the digest is ready. Prefer
  `start_session` for background runs where the user may want to stop early.
- **Don't ask the user for their Instagram password in chat or tool
  parameters.** When `login` returns `pending_credentials`, tell the user
  to set `IG_USERNAME` + `IG_PASSWORD`, or `IG_SESSIONID` /
  `INSTAGRAM_SESSIONID`, outside the LLM/tool-call path and restart the
  gateway. Never echo, log, summarize, or pass credentials in tool params.
- **Don't guess 2FA codes.** If you don't have a code from the user,
  don't make one up — Instagram locks accounts on repeated wrong
  codes. Return `pending_2fa` handling back to the user.

---

## Minimal example transcript

```
user: what's happening on my feed today?

agent: How many minutes would you like the run to be?

user: 20 minutes

agent: Starting a 20-minute Kowalski digest — 6 minutes for stories,
  14 minutes for feed/posts. Cost depends on your configured provider.
  I'll kick it off in the background; say "stop" any time to abort.
  → start_session({ duration_minutes: 20 })
  ← { status: "started", session_id: "abc…", triggered_by: "start_session", … }

agent: Digest running in the background. You'll see ⏱ progress ticks
  in the log pane every 5 min. Ask "is it done?" whenever you want me
  to check.

...later, after the user asks "is it done?"...

agent: → print_digest({ session_id: "abc…" })
  ← { status: "pending", digest_status: "running", silent: true, recommended_next_poll_ms: 30000, … }

agent: Still running.

...later, after the user asks again...

agent: → print_digest({ session_id: "abc…" })
  ← "# Play-In Night\n\n## 🏀 Top Story: …"

agent: Yep, done! Here's what's on your feed today: …
```
