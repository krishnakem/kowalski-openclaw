---
name: instagram-digest
description: Run the Kowalski Instagram digest pipeline — capture stories and feed, extract posts, and produce a markdown digest summarizing what the user would see on their Instagram home if they opened it now. Trigger on digest-style asks like "what's happening on my feed", "what did I miss on Instagram today", "run the feed digest", "summarize my IG", "catch me up on stories", or "kowalski run". Do NOT trigger on generic "open Instagram" or "browse Instagram" requests — this skill is for producing a digest, not for interactive browsing.
---

# Instagram digest playbook

This skill orchestrates the Kowalski OpenClaw plugin to capture the user's
Instagram home (stories + feed) and return a markdown digest. It is a
blocking, multi-tool workflow that typically takes 10–30 minutes and costs
$1–3 in Anthropic API spend (worst case: ~45 min, ~$3).

The plugin exposes eleven tools: `start_session`, `login`,
`submit_verification_code`, `run_digest`, `get_session_status`,
`set_api_key`, `clear_api_key`, `reset_memory`, `reset_all`,
`stop_run`, `end_session`.

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

Before calling, tell the user something like:

_"Kicking off the digest now — this takes 10–30 minutes (hard caps:
15 min stories + 30 min feed, so worst case ~45 minutes) and costs
roughly $1–3 in API spend. The run goes in the background once login
is verified. Say "stop" any time to abort, or ask me "is it done?"
and I'll check."_

Then call with no args unless the user specified phases (see Parameter
notes).

```json
{ "name": "start_session", "arguments": {} }
```

`start_session` can return any of these shapes:

```json
{ "status": "pending_api_key", "message": "…" }
```

No Anthropic API key is available from OpenClaw config,
`ANTHROPIC_API_KEY`, or the OS keychain. Ask the user for their
Anthropic API key (it starts with `sk-ant-`), then call:

```json
{ "name": "set_api_key", "arguments": { "api_key": "sk-ant-…" } }
```

Never echo or summarize the key. If `set_api_key` fails because the OS
keychain is unavailable, tell the user this is common on headless servers
or minimal VMs and ask them to restart the gateway with
`ANTHROPIC_API_KEY` set instead. After `set_api_key` succeeds, retry
`start_session`.

```json
{ "status": "started", "session_id": "…", "triggered_by": "start_session", "message": "…" }
```

Digest has started. Tell the user the run is in flight and save the
`session_id` for status/stop calls.

```json
{ "status": "pending_credentials", "session_id": "…", "message": "…" }
```

No Instagram credentials are available. Ask the user in the TUI for their
Instagram username (or email/phone) and password. When they reply, call
`login` with those values. If the user refuses to type their password
into chat, stop the login flow politely; this plugin is headless-only.

```json
{ "name": "login",
  "arguments": { "session_id": "…", "username": "…", "password": "…" } }
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
the digest and returns `status: "started"`. If it returns `pending_2fa`
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

After a `status: "started"` response, tell the user the digest is running
in the background and wait for them to prompt with "how's it going?",
"stop", or similar. Do NOT autonomously loop on `get_session_status`.

**Answering "how much time is left?" mid-run.** Read the most recent
progress line from the TUI log pane scrollback and report the numbers
verbatim. You can also call `get_session_status` to read
`digest_elapsed_ms`.

**Answering "is it done?" / "show me the digest".** Call:

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

The response includes `digest_status`:

- `"running"` — still in flight. Report elapsed time, remind user
  they can say "stop".
- `"completed"` — digest is ready. The response also carries
  `digest_result` (the full header + JSON body). Present it to the user.
- `"stopped"` — user-stop aborted it partway. `digest_result` carries
  the partial digest.
- `"failed"` — run errored out. `digest_error` explains why.
- `"idle"` — no digest has been started on this session yet.

### 3. Present The Result

When `get_session_status` returns `digest_status: "completed"` or
`"stopped"`, its `digest_result` field is a text block with a header
(record id, save path, PDF path, capture counts, optional timeout
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

`get_session_status` auto-ends the session on the call that first
delivers a completed/stopped digest result, so do not call `end_session`
after that response says `session_ended: true`. Failed sessions remain
available for inspection or explicit cleanup.

---

## Non-digest paths

### "Set my API key" / pending_api_key

```json
{ "name": "set_api_key", "arguments": { "api_key": "sk-ant-…" } }
```

Validates the key with Anthropic, stores it in the OS keychain, and keeps
it in memory for the current gateway process. Never log or echo the key.
If the OS keychain backend is unavailable, tell the user to set
`ANTHROPIC_API_KEY` before launching `openclaw gateway run`.

### "Clear my API key" / "Forget my Anthropic key"

```json
{ "name": "clear_api_key", "arguments": {} }
```

Clears the Anthropic API key stored in the OS keychain and forgets the
in-memory cached key. It is idempotent. It does not clear OpenClaw plugin
config or an `ANTHROPIC_API_KEY` env var.

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
`analysis_records/<id>.json` plus every run's screenshots), and the
Anthropic API key stored in the OS keychain. It does NOT delete digest
PDFs already written to Downloads, and it does NOT clear OpenClaw plugin
config or an `ANTHROPIC_API_KEY` env var. After resetting, the next
`start_session` will ask for whichever of API key and Instagram login is
no longer available.

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

Call `stop_run` immediately. Because `run_digest` is non-blocking, this
tool dispatches instantly — no gateway queueing. If you have the
session_id, pass it. If the user asks to stop and you do not have a
reliable session_id, call `stop_run` with `{}`; it is also a global stop
switch and writes the plugin-level marker. Do not poll status first just
to rediscover a session id when the user asked to stop.

The run will finalize within ~30 seconds and produce a partial digest
with whatever was captured so far. The digest will have `aborted: true`
and `abortReason: user-stop` in its metadata.

```json
{ "name": "stop_run", "arguments": { "session_id": "…" } }
```

```json
{ "name": "stop_run", "arguments": {} }
```

After `stop_run` returns, poll `get_session_status`; when
`digest_status` becomes `"stopped"`, the response carries the partial
`digest_result`. Present that to the user. If you stopped globally
because the session id was missing/stale, tell the user the stop marker
was sent and wait briefly before starting another digest.

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
- **Most other tools** take `{ session_id: string }`.
  Exceptions: `stop_run` may take `{ session_id?: string }` or `{}` as
  a global stop switch; `set_api_key` takes `{ api_key: string }`;
  `clear_api_key` takes `{}`; and `reset_all` takes optional
  `{ confirm: boolean }`. `submit_verification_code` also takes
  `{ login_id: string, code?: string | null }` — `login_id` comes from
  a prior `login` pending response.

---

## Cost + duration expectations

- **Typical full run:** 10–30 minutes, $1–3 in Anthropic spend.
- **Hard caps:** stories phase 15 min, feed phase 30 min.
- **Worst case:** ~45 min total, ~$3.

Always mention this range before calling `start_session` so the user can
abort upfront if the cost or time isn't acceptable.

---

## Failure modes to handle gracefully

| Trigger | What happened | How to respond |
| --- | --- | --- |
| `start_session` returns `pending_api_key` | No Anthropic API key is available from plugin config, `ANTHROPIC_API_KEY`, or the OS keychain. | Ask the user for their Anthropic API key, call `set_api_key`, then retry `start_session`. Never echo the key. If keychain storage fails, tell them to set `ANTHROPIC_API_KEY` before launching the gateway. |
| `set_api_key` returns an error about the OS keychain | The host has no available keychain backend, common on headless servers or minimal VMs. | Tell the user to set `ANTHROPIC_API_KEY` in the environment and restart the gateway. |
| `clear_api_key` succeeds | Stored keychain key and memory cache were cleared. | Confirm. If plugin config or `ANTHROPIC_API_KEY` still supplies a key, future sessions may still work. |
| `start_session` returns `pending_credentials` | Persistent profile has no valid cookie, and no creds are available (no params, no env). | Ask the user in the TUI for their IG username + password, then call `login` with the returned `session_id` and those params. If they refuse, stop the login flow politely. |
| `start_session` / `login` / `submit_verification_code` returns `status: "started"` | Login was already valid or has just been verified. | The digest is already running. Tell the user it is in flight and save the `session_id`. |
| `login` returns `pending_credentials` | No creds available after an explicit login retry. | Ask the user in the TUI for their IG username + password, then call `login` again with those params. If they refuse, stop the login flow politely. |
| `login` returns `login_failed_needs_manual` | Instagram showed a challenge the automated login cannot clear headlessly. | Relay the message, ask the user to approve or clear the challenge in the Instagram app on their phone, then retry login later. |
| `login` returns `pending_2fa` | Agentic flow hit a 2FA screen. | Ask the user for their code, call `submit_verification_code` with it. Do NOT guess the code. |
| `login` returns `pending_device_approval` | Agentic flow hit a device-push challenge. | Tell the user which device IG pinged (from `device_description`), then call `submit_verification_code` with `code: null` after they say they've approved it. |
| `submit_verification_code` returns `pending_2fa` again | Code was rejected. | Ask for a fresh code (the previous one may have timed out). |
| `submit_verification_code` returns `still pending` for device approval | User hasn't approved yet. | Ask if they saw the notification and call again with `code: null`. |
| `submit_verification_code` returns `context_destroyed` | The pending-login browser was closed before the code was submitted (stale entry, Chromium crash, or out-of-band close). | Re-run `login` from scratch. The earlier attempt may have persisted enough cookies that Instagram skips 2FA the second time. |
| `run_digest` error contains `"OFFLINE"` | Offline watchdog tripped (3 consecutive probe failures). Likely a transient network blip. | Suggest retrying. The partial record is still on disk under `analysis_records/<id>.json` with `aborted: true, abortReason: offline`. |
| `run_digest` error mentions `"timed out"` / the header mentions `"Stories phase timed out after 15 minutes"` or `"Feed phase timed out after 30 minutes"` | A phase hit its hard cap. The digest still runs with partial captures; the record has `aborted: true` and `abortReason: timeout-stories` or `timeout-feed`. | Offer to show the partial digest — it's real, just cut short on that phase. |
| `run_digest` returns "another run already in progress" | The previous run is still holding the RunManager singleton. | Call `get_session_status` to see what's happening; if stale or no reliable session id exists, call `stop_run` with `{}` and wait briefly before retrying. |
| `stop_run` says it used the global stop marker because session_id was missing/stale | The session registry entry was gone, but the singleton runner may still be active. | Treat this as a successful stop request. Tell the user the global stop marker was sent and wait briefly before starting another digest. |
| `stop_run` returns successfully but the digest takes longer than 30 s to arrive | Normal — the stop marker is polled every ~3 s, and the agent needs to finish its current step. | Let it finalize. |

---

## Don'ts

- **Don't call `login` immediately after `start_session` returns
  `status: "started"`.** The digest is already running.
- **Don't autonomously loop on `get_session_status`.** Wait for the
  user to prompt ("is it done?", "how's it going?", "stop"). Polling
  in a tight loop burns agent turns needlessly.
- **Don't call `run_digest` after a successful `start_session`, `login`,
  or `submit_verification_code` response.** Those tools now start the
  digest automatically when auth is verified. `run_digest` is only a
  manual recovery/control-plane tool.
- **Don't call `run_digest` again while one is running** — you'll get
  `status: "already_running"`. Either wait or call `stop_run` first.
- **Don't ask the user for their Instagram password outside the login
  flow.** You ask exactly once, when `login` returns `pending_credentials`
  (or before the very first `login` call if you already know no env vars
  are set). If they already gave them to you earlier in the conversation,
  re-use what's cached on the session — don't ask again. Never echo
  the password back to them, never log it, never include it in any
  summary. If they refuse to share the password, stop the login flow
  politely because the plugin has no visible-browser fallback.
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
  ← { status: "started", session_id: "abc…", triggered_by: "start_session", … }

agent: Digest running in the background. You'll see ⏱ progress ticks
  in the log pane every 5 min. Tell me when to check or to stop.

user: is it done?

agent: → get_session_status({ session_id: "abc…" })
  ← { digest_status: "completed", digest_result: "# Kowalski digest…", session_ended: true, … }

agent: Yep, done! Here's what's on your feed today: …
```
