---
name: instagram-digest
description: Run the Kowalski Instagram digest pipeline — capture stories and feed, extract posts, and produce a markdown digest summarizing what the user would see on their Instagram home if they opened it now. Trigger on digest-style asks like "what's happening on my feed", "what did I miss on Instagram today", "run the feed digest", "summarize my IG", "catch me up on stories", or "kowalski run". Do NOT trigger on generic "open Instagram" or "browse Instagram" requests — this skill is for producing a digest, not for interactive browsing.
---

# Instagram digest playbook

This skill orchestrates the Kowalski OpenClaw plugin to capture the user's
Instagram home (stories + feed) and return a markdown digest. It is a
blocking, multi-tool workflow that typically takes 10–30 minutes and costs
$1–3 in Anthropic API spend (worst case: ~45 min, ~$3).

The plugin exposes nine tools: `start_session`, `login`,
`submit_verification_code`, `run_digest`, `get_session_status`,
`reset_memory`, `reset_all`, `stop_run`, `end_session`.

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

Follow these steps exactly. Each step depends on the previous.

### 1. `start_session`

Call with no args unless the user specified phases (see Parameter notes).

```json
{ "name": "start_session", "arguments": {} }
```

The tool returns JSON:

```json
{ "session_id": "…", "logged_in": true|false|null, "phases": […], "message": "…" }
```

Save the `session_id` — every subsequent tool call needs it.

### 2. Check `logged_in`

- `true` → jump to step 4.
- `false` or `null` → go to step 3.

### 3. `login` (only if needed)

Call `login` with the `session_id`. There are FIVE possible outcomes —
you MUST route each one correctly:

```json
{ "name": "login", "arguments": { "session_id": "…" } }
```

**a. Success (text response)** — e.g. `"Logged in agentically. Cookies
persisted to …"` or `"Logged in. Cookies saved to …"`. Jump to step 4.

**a1. `pending_credentials` (JSON response)** — no IG username/password is
available (neither passed as params, nor set as IG_USERNAME/IG_PASSWORD env
vars on the host). Response shape:

```json
{ "status": "pending_credentials", "session_id": "…", "message": "…" }
```

Ask the user in the TUI: _"To log in to Instagram, I need your username
(or email/phone) and password. What are they?"_ When they reply, call
`login` again with those values:

```json
{ "name": "login",
  "arguments": { "session_id": "…", "username": "…", "password": "…" } }
```

If the user refuses to type their password into chat, offer the headful
fallback instead — call:

```json
{ "name": "login",
  "arguments": { "session_id": "…", "force_headful": true } }
```

…and Instagram opens in a normal-looking browser window they can type
into directly. Never pressure the user; either path works.

**b. `pending_2fa` (JSON response)** — the agentic login reached a 2FA
screen and paused. Response shape:

```json
{ "status": "pending_2fa", "login_id": "…", "message": "…" }
```

Tell the user: _"Instagram asked for a 2FA code — what's the 6-digit
code from your authenticator app (or the SMS Instagram just sent)?"_
When they reply with the code, call:

```json
{ "name": "submit_verification_code",
  "arguments": { "login_id": "…", "code": "123456" } }
```

The `submit_verification_code` response has the same three shapes as
`login`: text-success, pending_2fa again (code was rejected — ask for a
fresh code), or a headful-fallback result. A fourth shape,
`context_destroyed`, can appear if the login browser got closed before
the code arrived (rare — e.g. another tool call nuked it, or Chromium
crashed). Re-run `login` from scratch; Instagram may not ask for 2FA
again if cookies partially persisted during the first attempt.

**c. `pending_device_approval` (JSON response)** — IG pushed a login
notification to another of the user's devices. Response shape:

```json
{ "status": "pending_device_approval", "login_id": "…",
  "device_description": "…", "message": "…" }
```

Tell the user: _"Instagram sent a login-approval notification to your
`<device_description>`. Open that device, tap Approve, then tell me
once you've done it."_ When they confirm, call:

```json
{ "name": "submit_verification_code",
  "arguments": { "login_id": "…", "code": null } }
```

(Note: `code` is `null` for device approval — the tool polls the page
for up to 120s waiting for the post-approval transition.) If the
response is `still pending`, ask the user to try the notification
again and call the same tool with `code: null` a second time, or
accept the headful fallback.

**d. Headful-fallback text response** — the agentic flow escalated
(suspicious-login challenge, stuck detection fired, or env vars weren't
set). The text will say `"Logged in. Cookies saved to …"` if the user
completed the headful window, or an error if they abandoned it. Tell
the user _"A login window just opened — finish logging in there and
I'll pick up the cookie automatically. The window will close itself."_

On error containing `"did not close the browser within 10 minutes"`,
the user abandoned the headful flow; suggest trying again.

**Credentials note.** The canonical path is: on first login, you ask
the user for their IG username and password in the TUI, then pass them
to the `login` tool as `username` and `password` params. The plugin
caches them on the session for the duration of the login round trip
(including 2FA follow-ups) so you only ask once — and they are never
logged, never returned in any response, never included in any prompt
sent to Claude. If the user declines to type their password into chat,
call `login` again with `force_headful: true` and a Chromium window
opens for them. Alternatively, power users can set `IG_USERNAME` and
`IG_PASSWORD` env vars before launching `openclaw gateway run` for
unattended/scheduled runs, in which case the first `login` call skips
`pending_credentials` and goes straight to the agentic flow.

### 4. Warn about cost + duration, then call `run_digest`

Before calling, tell the user something like:

_"Kicking off the digest now — this takes 10–30 minutes (hard caps:
15 min stories + 30 min feed, so worst case ~45 minutes) and costs
roughly $1–3 in API spend. The run goes in the background; you'll
see ⏱ progress ticks in the OpenClaw log pane every 5 minutes plus
on phase transitions. Say "stop" any time to abort, or ask me "how
much time is left?" / "is it done?" and I'll check."_

Then invoke:

```json
{ "name": "run_digest", "arguments": { "session_id": "…" } }
```

**This returns IMMEDIATELY** with `{ "status": "started", … }`. The
run continues in the background. Critically, because `run_digest` no
longer blocks the gateway, `stop_run` and `get_session_status` now
dispatch instantly — so "stop" in the TUI actually stops the run, and
status polls actually fire.

After run_digest returns, tell the user the run is in flight and wait
for them to prompt with "how's it going?", "stop", or similar. Do NOT
autonomously loop on `get_session_status` — let the user drive the
check-ins.

**Answering "how much time is left?" mid-run.** Read the most recent
`⏱` line from the TUI log pane scrollback and report the numbers
verbatim — e.g. _"Feed phase, 12m34s in, 17m26s left against the
30min cap; total elapsed 27m15s."_ Don't estimate or extrapolate.
If the most recent tick is more than ~5 minutes old, check for a
phase-transition line above it. You can also call `get_session_status`
to read `digest_elapsed_ms`.

**Answering "is it done?" / "show me the digest".** Call:

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

The response includes `digest_status`:

- `"running"` — still in flight. Report elapsed time, remind user
  they can say "stop".
- `"completed"` — digest is ready. The response also carries
  `digest_result` (the full header + JSON body). Present it to the
  user (see step 5).
- `"stopped"` — user-stop aborted it partway. `digest_result` carries
  the partial digest.
- `"failed"` — run errored out. `digest_error` explains why.
- `"idle"` — no digest has been started on this session yet.

### 5. Present the result

When `get_session_status` returns `digest_status: "completed"` or
`"stopped"`, its `digest_result` field is a text block with a header
(record id, save path, **PDF path**, capture counts, optional timeout
summary, lead-story preview) followed by a JSON body containing the
digest sections. Show this directly to the user. Three artifacts get
written every run:

- JSON record — `~/.kowalski/output/analysis_records/<id>.json`
- Text-only PDF — `~/Downloads/kowalski-digest-<id>.pdf` (or whatever
  `downloadsDir` is set to in plugin config)
- Run screenshots — `~/.kowalski/output/runs/<id>/` (referenced by the
  JSON `images` array)

Point the user at the PDF path in your reply — it's the easiest thing
for them to open or share.

### 6. `end_session`

When the user is done, call:

```json
{ "name": "end_session", "arguments": { "session_id": "…" } }
```

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
dir (session memory, stop markers, run temp), and the output dir (every
`analysis_records/<id>.json` plus every run's screenshots). It does NOT
delete digest PDFs already written to Downloads, and it does NOT clear
OpenClaw plugin config — the user's API key, `downloadsDir`, `userName`,
and `location` stay put. After resetting, the next `start_session` will
report `logged_in: false` and the user will need to `login` again.

Always ask before calling with `confirm: true`. If the user asks to
"reset everything" or "wipe Kowalski", do the dry-run first, show them
the preview, and wait for explicit confirmation before the real call.

### "Is the digest done?" / "How's the run going?"

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

Returns `digest_status` (`running` | `completed` | `stopped` | `failed`
| `idle`), last phase, recent ~20 pipeline events, and — when the
digest is done — a `digest_result` field with the full header + JSON
body. Because `run_digest` is non-blocking, this tool can be called at
any time during a run, and live polling works normally.

### "Stop the run" / "Cancel the digest" / "I've seen enough"

Call `stop_run` with the session_id. Because `run_digest` is
non-blocking, this tool dispatches instantly — no gateway queueing.
The run will finalize within ~30 seconds (often faster; the stop also
aborts any in-flight LLM fetch) and produce a partial digest with
whatever was captured so far. The digest will have `aborted: true` and
`abortReason: user-stop` in its metadata.

```json
{ "name": "stop_run", "arguments": { "session_id": "…" } }
```

After `stop_run` returns, poll `get_session_status`; when
`digest_status` becomes `"stopped"`, the response carries the partial
`digest_result`. Present that to the user.

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

- **`start_session`** takes optional `{ phases: ("stories" | "feed")[] }`.
  Default is `["stories", "feed"]`.
  - "Just feed" / "skip stories" → `phases: ["feed"]`
  - "Just stories" / "only stories" → `phases: ["stories"]`
- **Every other tool** (except `reset_memory`) takes
  `{ session_id: string }`. `submit_verification_code` also takes
  `{ login_id: string, code?: string | null }` — `login_id` comes from
  a prior `login` pending response.

---

## Cost + duration expectations

- **Typical full run:** 10–30 minutes, $1–3 in Anthropic spend.
- **Hard caps:** stories phase 15 min, feed phase 30 min.
- **Worst case:** ~45 min total, ~$3.

Always mention this range before calling `run_digest` so the user can
abort upfront if the cost or time isn't acceptable.

---

## Failure modes to handle gracefully

| Trigger | What happened | How to respond |
| --- | --- | --- |
| `start_session` returns `logged_in: false` | Persistent profile has no valid sessionid cookie. | Call `login` next — don't panic. |
| `login` returns `pending_credentials` | No creds available (no params, no env). | Ask the user in the TUI for their IG username + password, then call `login` again with those params. If they refuse, call `login` with `force_headful: true`. |
| `login` error contains "did not close the browser within 10 minutes" | User abandoned the headful-fallback flow. | Suggest trying again; no need to call login again unless the user confirms. |
| `login` returns `pending_2fa` | Agentic flow hit a 2FA screen. | Ask the user for their code, call `submit_verification_code` with it. Do NOT guess the code. |
| `login` returns `pending_device_approval` | Agentic flow hit a device-push challenge. | Tell the user which device IG pinged (from `device_description`), then call `submit_verification_code` with `code: null` after they say they've approved it. |
| `submit_verification_code` returns `pending_2fa` again | Code was rejected. | Ask for a fresh code (the previous one may have timed out). |
| `submit_verification_code` returns `still pending` for device approval | User hasn't approved yet. | Ask if they saw the notification and call again with `code: null`, OR accept the headful fallback by calling `login` fresh. |
| `submit_verification_code` returns `context_destroyed` | The pending-login browser was closed before the code was submitted (stale entry, Chromium crash, or out-of-band close). | Re-run `login` from scratch. The earlier attempt may have persisted enough cookies that Instagram skips 2FA the second time. |
| `run_digest` error contains `"OFFLINE"` | Offline watchdog tripped (3 consecutive probe failures). Likely a transient network blip. | Suggest retrying. The partial record is still on disk under `analysis_records/<id>.json` with `aborted: true, abortReason: offline`. |
| `run_digest` error mentions `"timed out"` / the header mentions `"Stories phase timed out after 15 minutes"` or `"Feed phase timed out after 30 minutes"` | A phase hit its hard cap. The digest still runs with partial captures; the record has `aborted: true` and `abortReason: timeout-stories` or `timeout-feed`. | Offer to show the partial digest — it's real, just cut short on that phase. |
| `run_digest` returns "another run already in progress" | The previous run is still holding the RunManager singleton. | Call `get_session_status` to see what's happening; if stale, call `end_session` on the old session and retry. |
| `stop_run` returns successfully but the digest takes longer than 30 s to arrive | Normal — the stop marker is polled every ~3 s, and the agent needs to finish its current step. | Let it finalize. |

---

## Don'ts

- **Don't call `login` speculatively.** Only call it when `start_session`
  reports `logged_in: false`.
- **Don't autonomously loop on `get_session_status`.** Wait for the
  user to prompt ("is it done?", "how's it going?", "stop"). Polling
  in a tight loop burns agent turns needlessly.
- **Don't call `run_digest` without a valid `session_id`.** Every run
  must be preceded by a `start_session` in the same agent turn-chain.
- **Don't call `run_digest` again while one is running** — you'll get
  `status: "already_running"`. Either wait or call `stop_run` first.
- **Don't ask the user for their Instagram password outside the login
  flow.** You ask exactly once, when `login` returns `pending_credentials`
  (or before the very first `login` call if you already know no env vars
  are set). If they already gave them to you earlier in the conversation,
  re-use what's cached on the session — don't ask again. Never echo
  the password back to them, never log it, never include it in any
  summary. If they refuse to share the password, call `login` with
  `force_headful: true` instead.
- **Don't guess 2FA codes.** If you don't have a code from the user,
  don't make one up — Instagram locks accounts on repeated wrong
  codes. Return `pending_2fa` handling back to the user.

---

## Minimal example transcript

```
user: what's happening on my feed today?

agent: Starting the Kowalski digest — takes 10–30 min, costs $1–3.
  I'll kick it off in the background; say "stop" any time to abort,
  or ask "is it done?" and I'll check.
  → start_session()
  ← { session_id: "abc…", logged_in: true, … }
  → run_digest({ session_id: "abc…" })
  ← { status: "started", started_at: "…", message: "…" }

agent: Digest running in the background. You'll see ⏱ progress ticks
  in the log pane every 5 min. Tell me when to check or to stop.

user: is it done?

agent: → get_session_status({ session_id: "abc…" })
  ← { digest_status: "completed", digest_result: "# Kowalski digest…", … }
  → end_session({ session_id: "abc…" })

agent: Yep, done! Here's what's on your feed today: …
```
