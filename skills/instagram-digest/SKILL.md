---
name: instagram-digest
description: Run the Kowalski Instagram digest pipeline — capture stories and feed, extract posts, and produce a markdown digest summarizing what the user would see on their Instagram home if they opened it now. Trigger on digest-style asks like "what's happening on my feed", "what did I miss on Instagram today", "run the feed digest", "summarize my IG", "catch me up on stories", or "kowalski run". Do NOT trigger on generic "open Instagram" or "browse Instagram" requests — this skill is for producing a digest, not for interactive browsing.
---

# Instagram digest playbook

This skill orchestrates the Kowalski OpenClaw plugin to capture the user's
Instagram home (stories + feed) and return a markdown digest. It is a
blocking, multi-tool workflow that typically takes 10–30 minutes and costs
$1–3 in Anthropic API spend (worst case: ~45 min, ~$3).

The plugin exposes seven tools: `start_session`, `login`, `run_digest`,
`get_session_status`, `reset_memory`, `stop_run`, `end_session`.

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

Tell the user: _"I need you to log in once — a browser window will open,
log into Instagram and I'll pick up the cookie automatically."_

Then call `login` with no args and wait for it to return. The tool
auto-detects the valid `sessionid` cookie via polling and closes the
window itself — **do not tell the user to close it manually**.

On error containing `"did not close the browser within 10 minutes"`, the
user abandoned the login flow; suggest trying again.

### 4. Warn about cost + duration, then call `run_digest`

Before calling, tell the user something like:

_"Running the digest now — this takes 10–30 minutes (worst case ~45
minutes) and costs roughly $1–3 in API spend. It's a single blocking
call, so I won't be able to give progress updates until it finishes."_

Then invoke:

```json
{ "name": "run_digest", "arguments": { "session_id": "…" } }
```

This blocks. Do NOT poll `get_session_status` during the call — OpenClaw
serializes tool calls per session, so polling can't fire until
`run_digest` returns anyway.

### 5. Present the result

`run_digest` returns a text block with a header (record id, save path,
capture counts, optional timeout summary, lead-story preview) followed
by a JSON body containing the digest sections. Show this directly to
the user. The full record is persisted at
`~/.kowalski/output/analysis_records/<id>.json`.

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
slate. Idempotent.

### "Is the digest done?" / "How's the run going?"

```json
{ "name": "get_session_status", "arguments": { "session_id": "…" } }
```

Returns the last phase plus the most recent ~20 pipeline events. Useful
*between* runs — during a `run_digest` call, OpenClaw serializes tools
per session and the status call queues until the run completes, so don't
expect live polling.

### "Stop the run" / "Cancel the digest" / "I've seen enough"

Call `stop_run` with the session_id. The run will finalize within ~30
seconds and produce a partial digest with whatever was captured so far.
The digest will have `aborted: true` and `abortReason: user-stop` in its
metadata.

```json
{ "name": "stop_run", "arguments": { "session_id": "…" } }
```

**Power-user escape hatch.** Some OpenClaw versions strictly serialize
all tool calls per-plugin, in which case `stop_run` queues behind
`run_digest` and won't fire until the run ends. The same stop-marker can
be created manually from a separate terminal:

```bash
touch ~/.kowalski/scratch/STOP_REQUESTED
```

The next phase checkpoint (within ~30 s) picks it up. Result is
identical: graceful stop → finalize → partial digest.

Note: `end_session` does NOT interrupt a running `run_digest` — it only
takes effect after the run completes. Use `stop_run` (or the manual
marker) for mid-run aborts.

---

## Parameter notes

- **`start_session`** takes optional `{ phases: ("stories" | "feed")[] }`.
  Default is `["stories", "feed"]`.
  - "Just feed" / "skip stories" → `phases: ["feed"]`
  - "Just stories" / "only stories" → `phases: ["stories"]`
- **Every other tool** (except `login`, `reset_memory`) takes only
  `{ session_id: string }`.

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
| `login` error contains "did not close the browser within 10 minutes" | User abandoned the flow. | Suggest trying again; no need to call login again unless the user confirms. |
| `run_digest` error contains `"OFFLINE"` | Offline watchdog tripped (3 consecutive probe failures). Likely a transient network blip. | Suggest retrying. The partial record is still on disk under `analysis_records/<id>.json` with `aborted: true, abortReason: offline`. |
| `run_digest` error mentions `"timed out"` / the header mentions `"Stories phase timed out after 15 minutes"` or `"Feed phase timed out after 30 minutes"` | A phase hit its hard cap. The digest still runs with partial captures; the record has `aborted: true` and `abortReason: timeout-stories` or `timeout-feed`. | Offer to show the partial digest — it's real, just cut short on that phase. |
| `run_digest` returns "another run already in progress" | The previous run is still holding the RunManager singleton. | Call `get_session_status` to see what's happening; if stale, call `end_session` on the old session and retry. |
| `stop_run` returns successfully but the digest takes longer than 30 s to arrive | Normal — the stop marker is polled every ~3 s, and the agent needs to finish its current step. | Let it finalize. |

---

## Don'ts

- **Don't call `login` speculatively.** Only call it when `start_session`
  reports `logged_in: false`.
- **Don't poll `get_session_status` in a tight loop during `run_digest`.**
  The blocking tool dispatch means polls queue up and won't fire until
  the run returns.
- **Don't call `run_digest` without a valid `session_id`.** Every run
  must be preceded by a `start_session` in the same agent turn-chain.
- **Don't restart the run** just because you didn't see progress output.
  `run_digest` is intentionally silent while it works — assume it's
  still running unless `get_session_status` clearly says otherwise
  (which it can't tell you until after).

---

## Minimal example transcript

```
user: what's happening on my feed today?

agent: Starting the Kowalski digest — this typically takes 10–30 minutes
  and costs $1–3 in API spend. A browser window may open first if you
  haven't logged in yet.
  → start_session()
  ← { session_id: "abc…", logged_in: true, … }
  → run_digest({ session_id: "abc…" })
  ← # Kowalski digest …
      - captures: extracted=27, skipped=2, failed=0
      - lead story: …
      ```json
      { "sections": […] }
      ```
  → end_session({ session_id: "abc…" })

agent: Here's what's on your feed today: …
```
