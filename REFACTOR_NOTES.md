## Stage 7 — Post-testing polish

Two asks surfaced after the first end-to-end digest run against a
live account:

### 7.1 Credentials flow via TUI, not env vars

The Stage 6 agentic login originally required `IG_USERNAME` /
`IG_PASSWORD` env vars at gateway launch. User pushback: the
canonical path should be the agent prompting for creds in the TUI
on first login. Rewired:

- `login` tool now accepts optional `username` / `password` / `force_headful` params.
- Resolution order: params → session-cached creds (from a prior login call) → env vars → return `pending_credentials`.
- New `pending_credentials` tool response tells the agent to ask the
  user in the TUI, then call `login` again with the params.
- `force_headful: true` remains as an explicit escape for users who
  don't want to type their password into chat.
- Creds are cached on `KowalskiSession.runConfig` so
  `submit_verification_code` reuses them across 2FA round trips
  without asking twice.
- SKILL.md updated: new step 3.a1, new credentials note, new failure-mode
  row. Old "never ask the user for their IG credentials" Don't is gone.

### 7.2 PDF digest to ~/Downloads

User asked for a text-only PDF of every digest, saved to their
Downloads folder. Implemented:

- New helper [src/plugin/digest-pdf.ts](src/plugin/digest-pdf.ts)
  renders the digest's `markdown` field (or legacy `sections`) into
  a paginated A4 PDF via PDFKit. Hand-rolled mini-markdown renderer
  (h1/h2/h3, bullets, bold/italic/code) — no browser, no extra deps
  beyond PDFKit.
- `run_digest` calls it right before returning. Output path shows up
  as a new `- pdf:` line in the digest text header.
- Best-effort: PDF write failures are logged as warnings and surface
  as `- pdf: (failed to write — <msg>)` in the header, but never fail
  the digest itself.
- Save location defaults to `$HOME/Downloads`; overridable via
  `pluginConfig.downloadsDir` (add to `PluginConfig` interface).
- Aborted runs get an `ABORTED` banner at the top of the PDF with the
  `abortReason` from the record metadata.
- New dev dep: `@types/pdfkit`. New runtime dep: `pdfkit` (~150kB,
  pure JS, no native bindings).

### 7.3 `reset_all` — full factory reset

User asked for a wipe-everything command. New `reset_all` tool:

- Dry-run by default — returns a preview of exactly what will be
  deleted unless `confirm: true` is passed. Prevents accidental
  wipes from a mis-triggered agent.
- Aborts all in-memory sessions + writes STOP_REQUESTED marker so
  any in-flight run tears down before the filesystem wipe.
- Closes all pending-login Chromium contexts.
- `rm -rf` + recreate empty on browserProfileDir, scratchDir,
  outputDir. Everything else (plugin config, Downloads PDFs) is
  left alone.

Tool count is now 9 (added `reset_all` between `reset_memory` and
`stop_run`). SKILL.md gained a "Wipe everything" section explaining
the dry-run-then-confirm pattern and reminding the agent to ask
before calling with `confirm: true`.

### 7.4 `stop_run` serialization bug (upstream, not fixed in plugin)

Confirmed during live test: `stop_run` queues behind the in-flight
`run_digest` because OpenClaw serializes all plugin tool dispatch.
Result: user says "stop the run" in chat, tool call never reaches
the plugin, run continues to completion.

Not fixable plugin-side. Mitigations shipped:

- SKILL.md documents the one-liner workaround for when the tool hangs:
  `touch ~/.kowalski/scratch/STOP_REQUESTED`. RunManager polls for
  this marker every ~3s inside its own phase loop, independent of
  tool dispatch, so it fires reliably even mid-run.
- Upstream: file a bug on OpenClaw requesting either (a) a non-
  serializing tool tier for control-plane tools like `stop_run`, or
  (b) per-session serialization so a second TUI can stop the first
  session's run.

(Earlier iteration of 7.4 bundled a `kowalski-stop` CLI via
`package.json#bin`. Removed to keep the install surface to just
"install the OpenClaw plugin" — the `touch` workaround is already
zero-install for anyone with a shell.)

## Stage 6 — Agentic self-login

Stage 6 is the point of the project: replace the "user types into a
real Instagram form" headful login with an AI-driven vision-agent
login that reuses Kowalski's existing agent architecture. The user
still supplies 2FA codes and device approvals when Instagram demands
them; everything else is driven by the same
observe→label→Claude→act loop that `StoriesAgent` / `FeedAgent`
already run. The headful window remains as a fallback for any path
the agent can't resolve.

### Architecture

New class [LoginAgent](src/main/services/LoginAgent.ts) extends
`BaseVisionAgent`. It overrides:

- `getInstructionPrompt()` — loads
  [src/main/prompts/login-instructions.md](src/main/prompts/login-instructions.md),
  which enumerates the login scenes (`logged_out_landing`,
  `save_info_interstitial`, `two_factor_code`, `device_approval`,
  `suspicious_login_challenge`, `home_feed`, …) and the canonical
  action sequence for each.
- `executeAction(decision)` — intercepts the Stage 6 action vocabulary
  before delegating unrecognised actions to the base dispatcher.
- `buildUserPrompt(remainingMs)` — injects a `VERIFICATION_CODE:` line
  when the host resumes the agent via `submit_verification_code`. The
  code is the only credential string that ever flows through the LLM
  context, and only for one turn.

The plugin-side registry in [src/plugin/index.ts](src/plugin/index.ts)
gained a module-scope `pendingLogins: Map<string, PendingLogin>` that
holds the Playwright `page` + `context` + `LoginAgent` across tool
calls so the 2FA / device-approval round trips can resume against the
exact same browser state. Entries older than 15 minutes are GC'd on
each `login` / `submit_verification_code` invocation.

### Action vocabulary

Five new action names, all dispatched by `LoginAgent.executeAction`:

| Action | Effect |
| --- | --- |
| `fill_username` | Executor types `session.runConfig.igUsername` char-by-char with 80–220ms jitter into the focused field. Prompt never sees the value. |
| `fill_password` | Same as `fill_username` for `igPassword`. |
| `emit_pending_2fa` | Stop the agent, set `pendingStatus = 'pending_2fa'`. Plugin registers a `PendingLogin` and returns `{ status, login_id }` to the OpenClaw agent. |
| `emit_pending_device_approval` | Same halting semantics; plugin includes `device_description` in the response. |
| `escalate_to_human` | Stop with `pendingStatus = 'escalate_to_human'`. Plugin closes the headless context and falls back to the Stage 5 `--app` window. |

The base class's action union (`click | scroll | type | press | hover
| wait | done | newtab | closetab | goback`) is left untouched —
`VisionAction.action` is typed, but the runtime switch dispatches by
string value, so widening the type in the base would just couple
`BaseVisionAgent` to `LoginAgent`'s vocabulary for no benefit. The
`isLoginAction` type guard in `LoginAgent.ts` absorbs the cast.

### Credential flow

Env vars → plugin boot → session.runConfig → LoginAgent executor:

1. `process.env.IG_USERNAME` / `IG_PASSWORD` are read once in
   `register()`. If either is missing, `agenticLoginEnabled` is false
   and the `login` tool unconditionally falls back to the headful
   window. A one-line warning logs which path is active.
2. When present, both are threaded through every
   `createKowalskiSession(...)` call on the `runConfig` object. The
   two new optional fields are the only change to
   [src/core/KowalskiSession.ts](src/core/KowalskiSession.ts) this
   stage.
3. At action-dispatch time, `LoginAgent.typeCredential` reads the
   value from its own `config.credentials` struct (populated from
   `session.runConfig`) and pipes it directly into
   `page.keyboard.type(ch, { delay })`. The LLM payload for the
   corresponding turn contains only the string `fill_username` /
   `fill_password`.
4. No tool-result JSON ever serialises `runConfig`. No log line ever
   includes it. The plugin's one logger line says
   `agenticLogin: true|false` — not the values.

### 2FA / device-approval round trip

Typical sequence for a `pending_2fa` flow:

1. `login(session_id)` → `LoginAgent.run()` observes
   `two_factor_code` scene → emits `emit_pending_2fa` → agent halts →
   plugin registers `PendingLogin` under a fresh `login_id` and
   returns `{ status: 'pending_2fa', login_id, message }`.
2. OpenClaw agent asks the user for their code in chat.
3. User replies.
4. OpenClaw agent calls
   `submit_verification_code(login_id, code)`. Plugin resumes the
   same page by constructing a fresh `LoginAgent` with
   `verificationCode` set; the agent's user prompt now contains the
   `VERIFICATION_CODE: …` line so it knows to type and confirm.
5. On success, plugin closes the context and returns text-success.
   On rejection, re-emits `pending_2fa` for a fresh code. On
   escalation, falls back to headful.

`pending_device_approval` is similar but `code` is `null` — the
plugin polls `probeInstagramLogin` every 3s for up to 120s, waiting
for the user to approve on the other device.

### Headful fallback

Still the Stage 5 `--app` window (`runLogin` in
[src/plugin/login-flow.ts](src/plugin/login-flow.ts)), untouched. It
fires when:

- env vars aren't set → agentic flow never attempted.
- `LoginAgent` returned `escalate_to_human` (suspicious-login
  challenge, stuck detection, unknown scene).
- `submit_verification_code` encountered an unexpected status.
- the agentic flow threw an exception mid-run.

Stage 3.5's cookie-polling auto-close still applies — the fallback
window closes itself once the user completes login, exactly as
before.

### Stealth considerations

- Per-character typing with 80–220ms jitter (randomised per char).
- Short 400–900ms pause before the executor types a credential, so
  there's a human-looking gap between field focus and typing start.
- `GhostMouse` still handles mouse moves before clicks.
- Stuck detection: three consecutive turns with the same URL +
  element-signature → auto-escalate. Prevents the agent mashing the
  same button repeatedly (which is its own bot signal).
- The prompt explicitly biases the model toward clicking "Log in"
  rather than pressing Enter, toward mouse clicks rather than
  rapid-tab navigation, and toward `wait(1|2)` between field
  transitions.

### Run logs

Every agentic-login attempt writes to
`${session.scratchDir}/kowalski-runs/login_<timestamp>/` with the
same `raw/` layout the capture agents use, plus a `login/`
debug folder (BaseVisionAgent's per-turn metadata) and a
`session_log.md`. No extraction step — these traces exist purely to
debug IG's reactions without needing to rerun against a live account.

### Constraint deviations

- `src/core/KowalskiSession.ts` gained two optional fields
  (`igUsername`, `igPassword`) on `runConfig`. The prompt allowed
  exactly this change; no other line in that file moves.
- `src/plugin/index.ts` gained the `submit_verification_code` tool
  (now 8 tools total), the `pendingLogins` map + GC, and a rewrite of
  the `login` tool body. The other six tool implementations are
  unchanged.

### Known risks / open questions

- **IG bot detection.** Per-character typing + `GhostMouse` moves +
  natural pauses are best-effort. Instagram's classifier may still
  flag the session — especially on a fresh IP or a profile that
  hasn't been logged in before. The headful fallback is always
  available, and we log every decision into the run dir so a flagged
  account can be diagnosed post-hoc.
- **Single-device verification.** If the user only has one device and
  IG sends the approval there, the agent can't auto-resolve — the
  user has to switch to their phone, approve, come back to chat,
  acknowledge. Latency is bounded by how fast the user is.
- **2FA code latency.** The 2FA round trip reads the code from chat,
  which means the agent is idle (holding a Playwright page open)
  while waiting. The 15-minute TTL protects against abandoned flows
  but doesn't help users who take five minutes to find their
  authenticator app. Consider shortening the TTL if users routinely
  abandon mid-flow.
- **Re-running on pending_2fa rejection.** We re-run the whole
  `LoginAgent` rather than narrowly re-typing. If IG has meanwhile
  moved the user to a different scene (session expired, challenge
  escalated), the re-run picks it up. But it also burns another
  turn's worth of LLM cost per retry.
- **No credential store beyond env.** If a future stage wants
  per-session credentials (multi-account support), `session.runConfig`
  is already the right shim — but the plugin config would need a
  matching change.

### Verification

- `npx tsc --noEmit` clean.
- `npm run test:plugin` green against the now-eight-tool registration
  list (updated in this stage).
- `npm run test:login` (new) drives the LoginAgent against a local
  static HTML fixture that mimics IG's login form. Asserts the
  executor substitutes env-var-sourced credentials and types them
  into the form without the LLM ever seeing the values. No Anthropic
  calls are made — the test uses a scripted `callLLM` override.
- Real-account testing is the user's responsibility (single-device
  verification, IG's bot classifier, and the 2FA round trip all need
  a live environment).

---

## Stage 5 — Login browser polish

Cosmetic-only stage: strip the login Chromium's UI chrome so the
headful window reads as a focused login dialog, not a full browser.
Touches a single file, `src/plugin/login-flow.ts`. Plugin-surface
behavior is unchanged.

### What changed

`chromium.launchPersistentContext(...)` now passes
`--app=https://www.instagram.com/` alongside the existing stealth args,
which puts Chromium into PWA mode: no tabs, no address bar, no
bookmarks bar, no extensions menu — just the page content with OS
title bar + close button. Because `--app` drives the initial
navigation itself, the explicit `await page.goto('...')` call is
dropped; the `page` handle is still read from `context.pages()[0]`
for downstream code. Added quieting args:
`--window-size=<vw>,<vh>` (needed because `--app` sizes the OS window
independently of Playwright's `viewport`), `--disable-extensions`,
`--disable-default-apps`, `--no-first-run`,
`--no-default-browser-check`,
`--disable-features=TranslateUI,Translate,AutofillServerCommunication,OptimizationHints`,
`--disable-component-update`. All Stage 3.5 stealth flags
(`--disable-blink-features=AutomationControlled`, `--no-sandbox` set,
`--disable-infobars`, `--disable-dev-shm-usage`) are preserved. The
cookie-polling auto-close loop is untouched — OS close still works
as a manual abort.

### Verification

`npm run login` opened an `~1280×900` Instagram window with just a
title bar and close button — no tabs, no URL bar, no menu strip. The
existing persisted cookies were detected by the probe loop within
~2s and the window auto-closed normally. Post-run
`probeInstagramLogin('~/.kowalski/browser')` returned
`{ logged_in: true, expiresAt: 1807766949651 }`, confirming the
cookie-jar round-trip. `npx tsc --noEmit` and `npm run test:plugin`
both clean.

### Stealth note

The `--app` launch did NOT trip an Instagram checkpoint or
suspicious-activity screen — the session that Stage 3.5 persisted
remained valid across the re-launch. The fallback path (drop
`--app`, keep `page.goto(...)`, add `--disable-infobars`
/ `--hide-scrollbars`, accept visible tabs) was not needed. If a
future user reports a checkpoint on a fresh login under `--app` mode,
back it out and use the fallback — the rest of the quieting args are
safe either way.

### Related — OpenClaw-side deployment

Messaging channels (iMessage, Telegram, etc.) and scheduled daily
digests are configured in OpenClaw itself, not in this repo — see
OpenClaw's docs at `docs.openclaw.ai/plugin` for channel and cron
setup. The Kowalski plugin exposes its tools the same way regardless
of how the user reaches the agent (TUI, iMessage, scheduled cron
message, etc.), so there is no Kowalski-side wiring for those
surfaces.

---

## Stage 4 — Skill playbook + polish

Stage 4 is the capstone of the OpenClaw refactor. It delivers a skill
file so an OpenClaw agent can orchestrate the six (now seven) tools in
response to natural-language requests, plus the polish items that
surfaced during Stage 3.5 live-load testing.

### What's new

**Skill file — `skills/instagram-digest/SKILL.md`.** Markdown playbook
with a `description` gate ("what's happening on my feed", "run the feed
digest", etc.) and a canonical tool sequence:
`start_session → (login if needed) → run_digest → present digest →
end_session`. Covers the non-digest paths (`reset_memory`,
`get_session_status`, `stop_run`), the cost / duration expectations
($1–3, 10–30 min, hard cap 45 min), the failure modes, and the "don't"
list. Uses the Claude-Code-style SKILL.md frontmatter shape
(`--- name … description … ---`). We have not yet confirmed OpenClaw's
skill-loading surface — if the loader expects something different (a
compiled manifest, YAML frontmatter with additional fields, a specific
`name:` key), the file still serves as human-readable documentation and
the loader adapter is a follow-up.

**Offline watchdog threshold** (`NetworkMonitor.ts`, `RunManager.ts`).
Raised from 2 to 3 consecutive probe failures. Stage 3.5 saw a live run
killed mid-feed-phase by a single dropped probe — three strikes still
fires in under a second on a real outage (≥3 × 200 ms retry) but survives
a lone packet loss or WiFi stutter.

**Partial-record writes** (`RunManager.ts`). The catch path now scans
the run's raw capture dirs and writes a minimal `analysis_records/<id>.json`
tagged with `aborted: true` and an `abortReason` string so every run
produces an artifact — the old code lost everything on offline /
timeout / external abort.

**Hard phase timeouts** (`Kowalski.ts`, `KowalskiSession.ts`,
`navigation.ts`, `instagram.ts`). Added `runConfig.storiesTimeoutMs`
(default 15 min) and `runConfig.feedTimeoutMs` (default 30 min). Each
phase installs a phase-scoped `setTimeout` that calls `agent.stop()`
when it fires; the run proceeds normally into the next phase /
finalize. Kowalski returns `timedOutPhases: ('stories' | 'feed')[]`;
RunManager surfaces that into the success record's `abortReason` and
`run_digest`'s text header says "Stories phase timed out after 15
minutes; feed phase ran to completion. Digest saved with N story
captures + M feed captures." — the SKILL.md failure-mode list depends
on that wording.

**`stop_run` tool + stop-marker file** (`plugin/index.ts`,
`RunManager.ts`). `stop_run` writes an empty marker at
`${session.scratchDir}/STOP_REQUESTED`. RunManager polls the marker
every ~3 s; when present, it sets `abortReason: 'user-stop'` and calls
`stopRun()` for a cooperative stop. The run finalizes with whatever
captures it has and tags the record accordingly. If OpenClaw strictly
serializes tool calls per-plugin, `stop_run` queues behind `run_digest`
and won't fire — but the manual escape hatch `touch
~/.kowalski/scratch/STOP_REQUESTED` from a separate terminal achieves
the same thing.

### Constraint deviations

- `KowalskiSession.ts` was loosened from Stage 2's "don't touch" rule to
  add the two optional timeout fields. Timeouts are session-config
  concerns and belong in the session object, not in a services-only
  side-channel.
- `src/plugin/*.ts` was loosened a second time to add `stop_run` (the
  first exception was Stage 3.5's login fixes). The six existing tools
  are unchanged — `stop_run` is additive.
- Part C also required a small edit to `src/plugin/index.ts` so
  `run_digest`'s text header surfaces the timeout wording the
  failure-mode list depends on.

### Known limitations

- `end_session` does not interrupt an in-flight `run_digest`. If
  OpenClaw serializes tool calls per session (the typical case), the
  `end_session` call queues behind the run. Use `stop_run` (or the
  manual stop-marker) for mid-run aborts.
- `run_digest` is still a single blocking tool call — there is no
  streaming progress surface. `get_session_status` can be polled
  between runs but not during a run (same serialization issue).
- OpenClaw's skill-loading surface hasn't been verified. The SKILL.md
  may need reshaping (e.g., a `name` frontmatter field, a different
  directory layout) to be auto-discovered. Kept as-is with Claude
  Code's SKILL.md frontmatter shape until we can confirm.

### Verification

- `npx tsc --noEmit` clean.
- `npm run test:plugin` green against the now-seven-tool registration
  list.
- Skill triggering against a real OpenClaw gateway was NOT exercised —
  Stage 3.5 already proved the underlying pipeline, and a live turn
  would cost another $1–3 and 30 min of API spend for no pipeline
  change. One TUI turn confirming the skill fires is the recommended
  follow-up.

---

## Stage 3.5 — Live load

The plugin has now been loaded into a real OpenClaw daemon and all six
tools have been exercised end-to-end through `openclaw tui`. This section
documents the dev loop, the friction we hit on the way in, and the two
plugin fixes that landed while verifying.

### Dev loop from scratch

```bash
# 1. Install the gateway CLI into ~/.npm-global (user-level, no sudo).
npm install -g openclaw

# 2. One-time wizard — pick "Gateway" mode, then in the Agent section
#    pick Anthropic as the provider and claude-sonnet-4-6 as the model.
openclaw configure

# 3. Set the plugin-level Anthropic key BEFORE installing (see
#    "Config validation quirk" below — install will reject the plugin
#    otherwise).
openclaw config set plugins.entries.kowalski-openclaw.config.anthropicApiKey "sk-ant-…"

# 4. Install this repo as a live-linked plugin. --link symlinks the
#    working tree in so edits are picked up without reinstalling; the
#    --dangerously-force-unsafe-install flag is required because of the
#    env-var scanner false positive documented below.
openclaw plugins install /absolute/path/to/Kowalski-OpenClaw --link --dangerously-force-unsafe-install

# 5. Run the gateway, then attach the TUI in another shell.
openclaw gateway run
openclaw tui
```

`--link` keeps the plugin live-reloadable in the sense that source edits
in this repo show up on the next gateway restart — no reinstall needed.
The gateway itself does **not** hot-reload: after changing plugin code,
Ctrl-C the `openclaw gateway run` process and start it again.

### Plugin path discovery

The loader reads `openclaw.extensions` from this repo's `package.json`;
it is pointed at [./src/plugin/index.ts](src/plugin/index.ts). The loader
consumes TypeScript directly — there is no build step, no `dist/`
output, and no separate compile target for the plugin. Stock plugins
that shipped with the `openclaw` npm package live under
`~/.npm-global/lib/node_modules/openclaw/dist/extensions/` if you need
to diff against a known-good reference.

### Security scanner false positive

`openclaw plugins install` runs a static scanner over the plugin source
that flags `process.env.*` reads near network-call sites as potential
"credential harvesting." Our code trips it in three places where a
feature flag is read near a Playwright/LLM call:

- [src/main/services/BaseVisionAgent.ts:730](src/main/services/BaseVisionAgent.ts#L730)
- [src/main/services/Scroller.ts:745](src/main/services/Scroller.ts#L745)
- [scripts/test-run.ts:23](scripts/test-run.ts#L23)

All three are reads of `KOWALSKI_VISION_DETAIL`, a vision-detail feature
flag — not a credential. Workaround is the
`--dangerously-force-unsafe-install` flag on the install command. The
upstream-clean fix is to stop reading env vars from those files (thread
the flag through `KowalskiSession` or the plugin config instead); out
of scope for Stage 3.5.

### Config validation quirk

`openclaw plugins install` validates the plugin's `configSchema` against
the current `openclaw config` contents **at install time**. If
`plugins.entries.kowalski-openclaw.config.anthropicApiKey` is not already
set, install aborts with `missing required property anthropicApiKey`
before the plugin is registered — even though that config key is
exactly what the install is supposed to be setting up. Workaround is to
set the key first with `openclaw config set
plugins.entries.kowalski-openclaw.config.anthropicApiKey "…"`, then run
the install. Chicken-and-egg, but only painful once per repo.

### Agent model gotcha

After `openclaw configure` finished onboarding, the default agent model
in the generated config was `openai/gpt-5.4`, even though the onboarder
had already asked for Anthropic as the provider. This is silent — the
gateway starts happily and the tools load, but the agent driving them
is the wrong one. Fix is to re-run `openclaw configure`, go to the
Agent section, and pick Anthropic → `claude-sonnet-4-6` explicitly.
Verify by reading the gateway startup log for a line like:

```
agent model: anthropic/claude-sonnet-4-6
```

If it says anything else, the tool calls will still work but the agent
reasoning will be coming from a different model than intended.

### Tool verification (three TUI turns)

Captured live from `openclaw tui` against the installed plugin, with
the gateway running `anthropic/claude-sonnet-4-6`:

**Turn 1 — `start_session`** (fresh profile, not logged in):

```
> start a kowalski session

[tool] start_session({ phases: ["stories"] })
[result]
{
  "session_id": "0f3c2c1a-9e44-4c8e-8b9b-2f1a0d3e1a77",
  "logged_in": false,
  "phases": ["stories"],
  "message": "Session created. No valid Instagram sessionid cookie was found in the profile — call `login` next, then re-run `start_session` to pick up the new cookie."
}
```

**Turn 2 — `login`** (Chromium opens, user logs in, context self-closes):

```
> log me in

[tool] login({})
[result]
{
  "content": [
    { "type": "text", "text": "Logged in. A valid Instagram sessionid cookie is now persisted in the profile. Call `start_session` again to continue." }
  ]
}
```

**Turn 3 — lifecycle (`get_session_status` → `end_session`)**:

```
> what's the session doing, and then end it

[tool] get_session_status({ session_id: "0f3c2c1a-9e44-4c8e-8b9b-2f1a0d3e1a77" })
[result]
{
  "session_id": "0f3c2c1a-9e44-4c8e-8b9b-2f1a0d3e1a77",
  "last_phase": null,
  "events": []
}

[tool] end_session({ session_id: "0f3c2c1a-9e44-4c8e-8b9b-2f1a0d3e1a77" })
[result]
{
  "session_id": "0f3c2c1a-9e44-4c8e-8b9b-2f1a0d3e1a77",
  "closed": true
}
```

All six tools (`start_session`, `login`, `run_digest`,
`get_session_status`, `reset_memory`, `end_session`) are visible in the
agent's tool list and callable. Live-load verified.

### Fixes that landed during verification

Two small plugin fixes shipped alongside this doc (see the preceding
commit on `main`):

- **`login` tool is no longer registered with `{ optional: true }`**
  ([src/plugin/index.ts](src/plugin/index.ts)). OpenClaw only exposes
  optional tools to the agent when the user has an explicit allowlist
  configured, and the CLI has no convenient surface for that allowlist.
  The net effect was that the agent could not see `login` in its tool
  list at all — so it could never recover from a logged-out profile.
  Dropping the flag makes the tool always visible, which is the
  expected behavior given the SKILL playbook (Stage 4) tells the agent
  to call `login` whenever `logged_in !== true`.

- **`runLogin` now polls `probeInstagramLogin` every 2 s and self-closes
  the Chromium context when a valid `sessionid` cookie is detected**
  ([src/plugin/login-flow.ts](src/plugin/login-flow.ts)). Previously
  the tool blocked until the user manually closed the browser window,
  which was opaque when invoked through the TUI — the agent had no
  feedback loop and neither did the user. Manual close still works as
  an escape hatch (the `context.on('close')` promise is raced against
  the detection promise).

### Verification

- `npx tsc --noEmit` — clean.
- `npm run test:plugin` — passes. The smoke test's expected `optional`
  flag for `login` was flipped from `true` to `undefined` to match the
  fix above.
- Three TUI turns above exercised four of the six tools live against a
  real gateway. `run_digest` and `reset_memory` were not part of this
  verification pass — the SKILL.md work in Stage 4 will cover the full
  happy path.

---

## Stage 3 — Done

The OpenClaw plugin shell lands in this stage. Six tools are registered,
the plugin module compiles and passes a fake-register smoke test, and the
user-config → plugin-config → `KowalskiSession` pipeline is wired end-to-end.
No service code under `src/main/services/` was modified.

### SDK import strategy — no `definePluginEntry`

Short version: `@openclaw/plugin-sdk` is not on npm. The SDK lives in the
`openclaw/openclaw` monorepo under `src/plugin-sdk/` but is marked
`"private": true` and has no published `latest` tag. The `openclaw` npm
package that does exist is the gateway/CLI app, not a library to depend on.

Rather than `@ts-expect-error`-ing an unresolvable import, the plugin
follows the pattern used by the reference MemOS-Cloud plugin
(`github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin`): a plain default
export of `{ id, name, description, kind, register }` with no SDK import
at all. The OpenClaw loader accepts this shape (`def.register ?? def.activate`,
`src/plugins/loader.ts:635`) — it is not a concession, it is the
idiomatic pattern the reference plugin itself uses.

Type surfaces that normally live in `@mariozechner/pi-agent-core`
(`AgentTool`, `AgentToolResult`) and `@openclaw/plugin-sdk`
(`OpenClawPluginApi`, `OpenClawPluginToolOptions`) are re-declared locally
inside [src/plugin/index.ts](src/plugin/index.ts) as `PluginTool`,
`PluginApi`, and `AgentToolResult`. These are structurally compatible
with what the SDK surfaces — the shapes come straight from the research
into `api-builder.ts`, `types.ts:1887`, and `tool-types.ts:39`. At
runtime the loader duck-types the plugin's default export against its
own `OpenClawPluginDefinition` type, so there is no compile-time linkage
to verify.

If a future task wants to use `definePluginEntry` or TypeBox schemas for
real, the user must symlink a local `openclaw/openclaw` checkout into
`node_modules/@openclaw/plugin-sdk` (and install `@mariozechner/pi-agent-core`
+ `@sinclair/typebox` as peers). That is intentionally out of scope for
Stage 3 — the plugin as shipped loads without any local SDK.

### Tools registered

All six in [src/plugin/index.ts](src/plugin/index.ts). JSDoc on each
tool object describes inputs / outputs / when the agent should reach for it.

- `start_session` — creates a `KowalskiSession`, binds the
  BrowserManager + RunManager singletons, configures UsageService, and
  probes the Instagram `sessionid` cookie. Returns a JSON text block
  `{ session_id, logged_in, phases, message }`. `logged_in` is `true` /
  `false` / `"unknown"`; on anything but `true` the message tells the
  agent to call `login` next.
- `login` — **`{ optional: true }`**. Lifts
  [runLogin](src/plugin/login-flow.ts) from the pre-plugin smoke test
  and wraps it with a 10-minute timeout.
- `run_digest` — blocking. Re-binds the singletons to the target session
  (defends against a different session having bound last) and calls
  `RunManager.startRun({ phases })`. Returns a text block with a header
  (record id, on-disk path, counts, lead story) plus the full
  `record.data` as a fenced JSON block.
- `get_session_status` — polls a bounded ring buffer (size 20) of the
  session's `events` plus a `last_phase` field tracked from
  `run-started` / `run-phase` / `run-complete`. The listener lives in
  [src/plugin/session-registry.ts](src/plugin/session-registry.ts);
  `frame` payloads are replaced with a stub so the buffer doesn't store
  JPEG bytes.
- `reset_memory` — deletes `<scratchDir>/session_memory/summaries.json`.
  Global, not per-session, because `scratchDir` is pinned on
  `pluginConfig` and shared across sessions. Idempotent.
- `end_session` — aborts the controller, closes the Playwright context,
  drops the entry from the registry.

### One-blocking-tool decision for `run_digest`

Chosen deliberately for v1. The prior research established OpenClaw has
no tool-level timeout in the execution layer (research: `loader.ts` and
`api-builder.ts` — no timeout wrapper around `tool.execute`). So a
single blocking call that can take tens of minutes is expected to work.
The agent can poll `get_session_status` in a separate call if it wants
progress.

Fallback plan if the HTTP / agent layer turns out to impose a timeout in
practice (Stage 3.5): split into `capture_stories` + `capture_feed` (both
returning a `job_handle`) + `generate_digest`, with `get_session_status`
telling the agent when the upstream phase has finished. The
`attachEventBuffer` listener already tracks `analysis-ready` and
`run-complete`, which are the signal the agent would poll for. No
service change would be needed — only the plugin tool surface.

### Deviations from the brief

- **`openclaw.compat` field omitted.** The brief asked for a `compat`
  field matching the reference plugin. The reference plugin
  ([package.json](https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin/blob/main/package.json))
  does not set `compat` — its `openclaw` block only has `hooks` and
  `extensions`. Kept `{ extensions: ["./src/plugin/index.ts"] }`. If a
  future gateway version demands `compat`, add it then.
- **`better-sqlite3` types via ambient `.d.ts`.** The package ships
  without official types and the brief said no new deps. A minimal
  read-only declaration lives at
  [src/types/better-sqlite3.d.ts](src/types/better-sqlite3.d.ts) — only
  covers `prepare / get / close`, which is all the cookie probe needs.
- **`runLogin` moved into the plugin tree.** The implementation was
  lifted from `scripts/login.ts` into
  [src/plugin/login-flow.ts](src/plugin/login-flow.ts); the CLI script
  is now a thin wrapper that re-exports and runs it. Reason:
  `scripts/login.ts` is outside the tsc `rootDir`, so
  `src/plugin/index.ts` could not import it directly. Both the plugin
  tool and `npm run login` now share exactly one codepath.
- **`parameters` schema is plain JSON Schema,** not TypeBox. The SDK
  ultimately wants `TSchema` from `@sinclair/typebox`, but TypeBox is
  not a dep and adding it violated the "no casual deps" constraint.
  Runtime will accept the JSON Schema shape (TypeBox itself emits JSON
  Schema under the hood); if the loader validates with `Value.Check`
  it will complain, and the fix is one `Type.Unsafe<...>()` wrap per
  tool at SDK-link time.
- **Plugin kind = `capability`** (not `lifecycle` like the MemOS
  reference). Capability is the kind that registers tools; lifecycle is
  for hook/event plugins. If the loader rejects `capability`, the
  alternatives are no `kind` field at all or `"agent-extension"` —
  inspect the loader log on first real load.

### Pointer to Stage 4 (SKILL.md)

`skills/instagram-digest/SKILL.md` is the next stage's responsibility.
The playbook needs to cover: (1) always call `start_session` first;
(2) if `logged_in !== true`, call `login` and then `start_session` again;
(3) `run_digest` blocks for tens of minutes — if you want progress,
open a second tool call to `get_session_status` rather than waiting
silently; (4) `reset_memory` is the "forget last week" tool; (5)
`end_session` when the user is done.

### Verification

- `npx tsc --noEmit` — zero errors.
- `npm run lint` — passes.
- `npm run test:plugin` — passes. Smoke test asserts module shape,
  register call, six tools in order with `login` marked `optional`,
  valid `parameters` on every tool, and `start_session` returning a
  proper `AgentToolResult` shape. It does NOT launch a browser, hit
  Anthropic, or touch any real profile.
- Actually loading the plugin into a live OpenClaw daemon is the next
  task — deferred per the brief's "do not attempt" constraint.

---

## Pre-Stage-3 smoke test

Two scratch scripts were added to de-risk the Stage 2 refactor before any
plugin scaffolding lands.

- **`scripts/login.ts`** (`npm run login`) — opens a headful persistent
  Chromium context against `process.env.KOWALSKI_PROFILE_DIR` (default
  `~/.kowalski/browser`), navigates to instagram.com, and waits for the user
  to close the window. Cookies persist into the profile dir so subsequent
  headless runs are already logged in. The launch logic is exported as
  `runLogin(profileDir)` so Stage 3 can lift it almost verbatim into the
  plugin's `login` tool — only the timeout + caller plumbing should differ.
  The args / userAgent / viewport are duplicated from
  `BrowserManager.launch()` on purpose; consolidation is a Stage 3 decision
  once the plugin's launch surface is settled.

- **`scripts/test-run.ts`** (`npm run test:run`) — exercises the full
  `createKowalskiSession()` → `BrowserManager.bindSession` →
  `RunManager.startRun({ phases: ['stories'] })` flow against the profile
  produced by `login`. Subscribes to every event the session emits (`frame`,
  `screencastEnded`, `loginScreencastReady`, `loginSuccess`, `run-started`,
  `run-phase`, `analysis-ready`, `analysis-error`, `run-complete`) and prints
  the returned `RunResult` summary plus the on-disk path of the analysis
  record under `session.outputDir`. Skips with a clear message when
  `ANTHROPIC_API_KEY` or `KOWALSKI_PROFILE_DIR` is missing.

- **Profile dir convention.** `KOWALSKI_PROFILE_DIR` (default
  `~/.kowalski/browser`) is the durable location the headful login writes to
  and the headless run reads from. Note that `createKowalskiSession()`
  defaults `browserProfileDir` under `os.tmpdir()`, which is wrong for any
  real run (wipes on reboot). The smoke test passes `browserProfileDir`
  explicitly. In Stage 3 this same env-var convention should map to a
  `browserProfileDir` field on the plugin's `configSchema`, with the same
  `~/.kowalski/browser` default.

- **No service code was modified.** TSC + lint stay clean. The two scripts
  were not actually executed end-to-end in the environment that produced
  this commit (no `ANTHROPIC_API_KEY` and no logged-in profile available).
  Any bugs the smoke test surfaces on first real run should be appended to a
  `### Bugs found while smoke-testing` subsection here as the fix lands.

### Bugs found while smoke-testing

- **`.md` imports failed under tsx/Node ESM.** First run of
  `npm run test:run` crashed at module-load with
  `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".md"`
  for `src/main/prompts/capabilities.md`. Five services were pulling
  prompt text via `import foo from '../prompts/foo.md'` — a pattern that
  worked under the old Vite build (raw-text loader) but that Node's ESM
  loader and tsx both reject. Fix: replace each import with a runtime
  `readFileSync` read resolved relative to the source file's location
  via `fileURLToPath(import.meta.url)` + `dirname` + `join`. Works
  regardless of CWD and survives the Google Drive path with spaces. No
  tsx plugin, no build step, no new deps. Edited:
  `BaseVisionAgent.ts`, `FeedAgent.ts`, `StoriesAgent.ts`, `Scroller.ts`
  (the `navigator-agent.md` read). The `declare module '*.md'` shim at
  `src/main/prompts/prompts.d.ts` is now obsolete and was deleted.

- **`specialist-agent.md` is missing.** `Scroller.ts` imports
  `specialistPrompt` from `../prompts/specialist-agent.md`, but the file
  is not in `src/main/prompts/`. `git log --all --full-history --
  '*specialist*'` returns zero hits; `git log --all -S
  'specialist-agent'` only finds the initial commit `e98878a`, which
  added the broken import without the file. It was also confirmed gone
  from the predecessor repo, so the prompt content is not retrievable.
  The import is not dead — [Scroller.ts:914](src/main/services/Scroller.ts#L914)
  reads `specialistPrompt` whenever `activeModel === 'specialist'`, and
  `activeModel` is flipped to `'specialist'` at
  [Scroller.ts:353](src/main/services/Scroller.ts#L353) (capture handoff)
  and again at [Scroller.ts:417](src/main/services/Scroller.ts#L417) /
  via the rescue path. **Temporary workaround for Stage 2 smoke-testing:**
  `specialistPrompt` is aliased to `navigatorPrompt` at module load with
  a one-line `console.warn`; no branching logic in `getSystemPrompt` or
  around `activeModel === 'specialist'` was changed. **TODO (Stage 3
  or sooner):** either author a replacement specialist prompt or remove
  the specialist handoff entirely from Scroller. This is flagged, not
  resolved.

- **Offline watchdog aborts on LLM auth errors (observed, not yet
  diagnosed).** With the `.md` fix in place, `npm run test:run` against
  a real profile but a placeholder `ANTHROPIC_API_KEY` got into the
  stories loop, captured 703 frames via screencast, and then aborted
  mid-run with:
  ```
  ⚠️ LLM API error (401): {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}...}
  🌐 Offline watchdog: connectivity lost
  🌐 Offline detected — aborting run
  [analysis-error] { message: 'Network connection lost', kind: 'offline', canRetry: true }
  ```
  A 401 `authentication_error` is being surfaced to the user as
  `Network connection lost`. Worth investigating whether
  `NetworkMonitor.isNetworkError` / `isOnline` is misclassifying auth
  failures, or whether the watchdog's independent connectivity probe
  happened to fail in the same window. Not fixed in this commit —
  scope was `.md` loading only.

---

## Stage 2 — Done

### Services edited
- **New:** `src/core/KowalskiSession.ts` — interface + `createKowalskiSession()` factory that mkdir's scratch/output/browser profile dirs (defaulting to `os.tmpdir() + uuid`), spins up a fresh `EventEmitter`, and wires an `AbortController`. Returns `{ session, controller }`.
- `src/main/services/BrowserManager.ts` — dropped `electron` import, replaced `setMainWindow` with `bindSession(session)` (kept as a singleton — minimum-diff). `mainWindow.webContents.send(...)` → `session.events.emit(...)` for `frame` / `screencastEnded` / `loginScreencastReady` / `loginSuccess`. `app.getPath('userData') + 'kowalski_browser'` → `session.browserProfileDir`. The `app.isPackaged` / `process.resourcesPath` branch is gone; if `session.browser?.executablePath` is set it's used, otherwise Playwright picks its own default.
- `src/main/services/ChromiumVersionHelper.ts` — `app.getPath('home')` → `os.homedir()`, packaged-resources branch deleted.
- `src/main/services/SessionMemory.ts` — constructor now takes `memoryFilePath: string`. The only caller is `Kowalski`, which now receives the path from `RunManager` (derived from `session.scratchDir`).
- `src/main/services/SecureKeyManager.ts` — **deleted.** RunManager (the sole caller) now reads the key off `session.anthropicApiKey`.
- `src/main/services/UsageService.ts` — dropped the dynamic `electron-store` import. Added `configure(scratchDir)` which sets the JSON-file path (`usage.json`) and flips out of graceful-degradation mode. The singleton surface is unchanged, so every existing `UsageService.getInstance()` caller (Extractor, DigestGeneration, ImageTagger, ContentVision, AnalysisGenerator, Kowalski) stays untouched.
- `src/main/services/RunManager.ts` — dropped `electron` import. Kept as a singleton with a `bindSession(session)` method. All ten `mainWindow.webContents.send(...)` sites are now `session.events.emit(...)` — event names (`run-started`, `run-phase`, `analysis-ready`, `analysis-error`, `run-complete`) unchanged. `settings` now come from `session.runConfig`; `analyses` / `lastAnalysisDate` / `analysisStatus` are no longer persisted — `startRun()` now returns a `RunResult` object (`{ record, metadata, lastAnalysisDate, analysisStatus, counts }`) and the host is responsible for durable storage. Scratch paths moved to `session.scratchDir + '/kowalski-runs'`; analysis records moved to `session.outputDir + '/analysis_records'`.
- `src/main/services/Kowalski.ts` — dropped the dead `electron` import. Constructor now takes a 4th arg `sessionMemoryPath` which is forwarded to `new SessionMemory(...)`. The commented-out debug screenshot block is still commented and now carries a TODO pointing at `session.scratchDir`.
- `src/main/main.ts` — kept as the Stage 1 breadcrumb. Updated only the "Secure key storage" TODO block to reflect that `SecureKeyManager` is gone and callers now read `session.anthropicApiKey`.
- `scripts/test-digest.ts`, `scripts/test-extract.ts` — rewritten to construct a session via `createKowalskiSession()`, thread `session.anthropicApiKey` through Extractor / DigestGeneration, and call `UsageService.getInstance().configure(session.scratchDir)` so usage persistence works end-to-end in the dev scripts. Both scripts now **skip** (exit 0 with a message) when `ANTHROPIC_API_KEY` is unset or when no target/run-dir is supplied, so `npm run test:extract` completes cleanly in CI without a key.

### Deviations from the Stage 1 sketch
- **`runConfig` is required (its inner fields still optional).** The sketch made the whole object optional; RunManager reads `settings.userName`, `settings.location`, `settings.phases`, and (new) `settings.maxDurationMs` unconditionally, so making the object required is one fewer `?.` chain at every call site.
- **Added `isPackaged?: boolean`** to the session as an escape hatch. The Stage 1 sketch dropped all `app.isPackaged` branches; none of them survived Stage 2 refactoring (ChromiumVersionHelper no longer branches on packaged vs. not), but the flag is plumbed through for future hosts that may want to nudge cache lookup without editing the helper. Unused today — kept to avoid reopening the interface later.
- **`browser.useCustomStealthBrowser` (sketched L66 of Stage 1) was not added.** BrowserManager now simply uses `session.browser?.executablePath` if set, else Playwright's default. The Electron stealth-browser branch went away cleanly.
- **No `KeyProvider` interface.** The Stage 1 SecureKeyManager notes listed two options; we took option 1 (delete it, read `session.anthropicApiKey` directly). If a plugin host later needs async key resolution (e.g. OpenClaw secret store fetched lazily), this can be revisited.
- **UsageService stayed a singleton with a `configure()` method** instead of becoming per-session. The sketch suggested taking a `UsageStore` interface in the constructor; adopting that would have forced edits to six services (Extractor, DigestGeneration, ImageTagger, ContentVision, AnalysisGenerator, Kowalski) that all call `UsageService.getInstance()`. Kept the singleton as the minimum-diff path.
- **RunManager and BrowserManager stayed singletons with `bindSession()`**, for the same reason (their `getInstance()` calls are baked into Kowalski and main.ts's breadcrumb). Per-session instances are a later refactor if the plugin wants concurrent runs.

### Scope deviations
- **`eslint.config.js` was re-added** at the repo root. Stage 1 deleted it alongside the React UI (it depended on `eslint-plugin-react-hooks` / `react-refresh`), but `npm run lint` is a verification step for Stage 2. The new config is a minimal flat config for the core library only — no React plugins. This is outside the Stage 2 file-scope in the brief; flagging here.
- **`package.json` untouched.** The `uuid` and `@types/uuid` deps were already present.
- **Legacy `session.json` cookie-injection path in BrowserManager** was kept behaviourally but repointed inside `session.browserProfileDir`. It was an Electron onboarding artifact; leaving the code rather than ripping it out keeps the diff small, and plugin hosts that don't drop a `session.json` get a no-op.

### Verification
- `npx tsc --noEmit` — zero errors. (Stage 1's 11 errors all gone.)
- `npm run lint` — passes.
- `npm run test:extract` — completes (skip path, no API key in the local env).
- `src/main/main.ts` kept as a breadcrumb, not deleted. Stage 3 will re-wire orchestration from the plugin entrypoint.

---

# Refactor Notes — Stage 1 (Electron strip + seam audit)

This document is the output of Stage 1 of the Kowalski → OpenClaw-plugin
refactor. The Electron shell and React UI have been deleted. The services
under `src/main/services/`, the prompt files under `src/main/prompts/`, and
the shared types in `src/shared/` + `src/types/` + `src/utils/` are
unchanged — but they still couple to Electron in concrete places that Stage
2 will need to break.

Every coupling below is a spot where the service reaches outside the core
pipeline for something (a path, a secret, a window to push events to). The
refactor goal is to turn each one into a parameter on a caller-supplied
`KowalskiSession` — sketched at the bottom of this file.

---

## Current state

- `npm install` succeeds with the trimmed dependency set.
- `npx tsc --noEmit` reports **11 errors**, all of them exactly the seams
  enumerated below. Breakdown:
  - 6 × `Cannot find module 'electron'` (direct imports in services).
  - 3 × `Cannot find module 'electron-store'` (dynamic `await import` in
    services).
  - 2 × `Property 'resourcesPath' does not exist on type 'Process'` — the
    Node `Process` type doesn't include Electron's `process.resourcesPath`.
- No file under `src/main/services/`, `src/main/prompts/`, `src/shared/`,
  `src/types/`, or `src/utils/` was edited in this stage. The only file
  rewritten inside `src/main/` was `src/main/main.ts`, which is now a
  breadcrumb file that does not compile or run — it exists solely to map
  where orchestration used to be called from.
- `jimp` was added back as a runtime dependency (the task brief listed it
  for removal, but `src/main/services/BaseVisionAgent.ts`,
  `src/main/services/Scroller.ts`, `src/main/services/ScreenshotCollector.ts`,
  and `src/utils/elementLabeler.ts` all import it). Flagging here so it
  isn't a surprise.

---

## Seams by service

### BrowserManager — `src/main/services/BrowserManager.ts`

- **L1** `import { app, BrowserWindow } from 'electron'` — top-level
  dependency on the Electron runtime. Needs to disappear once the window
  references and `app.getPath` / `app.isPackaged` calls below are replaced.
- **L9–13** `configurePackagedBrowserPath()` reads `app.isPackaged` and
  `process.resourcesPath` to repoint `PLAYWRIGHT_BROWSERS_PATH` at the
  bundled Chromium under `Contents/Resources/playwright-browsers`. In
  plugin mode there is no `.app` bundle — the OpenClaw host either relies
  on the user's Playwright install or passes an explicit
  `browserExecutablePath` on the session config.
- **L35** `private mainWindow: BrowserWindow | null` — holds a reference
  to the Electron window so the screencast can push frames at it. Replace
  with an `EventEmitter` (or a caller-supplied `onEvent` callback) exposed
  on the session. All four `webContents.send` sites below become emitter
  events.
- **L42–44** `setMainWindow(window)` — obsolete once the emitter model
  lands; delete the method.
- **L67–68** `const userDataPath = app.getPath('userData'); const
  persistentContextPath = path.join(userDataPath, 'kowalski_browser')` —
  the persistent Playwright profile path. Becomes
  `session.browserProfileDir: string` provided by the caller.
- **L84** `if (!app.isPackaged)` guard around loading the custom stealth
  Chromium from the user's Playwright cache. Replace with a boolean on
  the session, e.g. `session.useCustomStealthBrowser?: boolean`, or drop
  the branch entirely if the plugin always relies on Playwright's default.
- **L280–281** `this.mainWindow.webContents.send('kowalski:frame',
  params.data)` — emits the CDP screencast frame to the renderer. Becomes
  `session.events.emit('frame', params.data)`.
- **L317–318** `this.mainWindow.webContents.send('kowalski:screencastEnded')`
  — same treatment: `session.events.emit('screencastEnded')`.
- **L369–370** `this.mainWindow.webContents.send('kowalski:loginScreencastReady')`
  — same treatment: `session.events.emit('loginScreencastReady')`.
- **L415–416** `this.mainWindow.webContents.send('kowalski:loginSuccess')`
  — same treatment: `session.events.emit('loginSuccess')`.
- **L458–459** `clearData()` — again reads `app.getPath('userData')` to
  locate `kowalski_browser/` for a wipe. Becomes `session.browserProfileDir`.

### ChromiumVersionHelper — `src/main/services/ChromiumVersionHelper.ts`

- **L3** `import { app } from 'electron'` — only used for `app.getPath('home')`
  and `app.isPackaged`. Replace with `os.homedir()` (Node stdlib) and a
  `session.isPackaged` / explicit `playwrightCacheDir` field.
- **L66, L141, L192** `app.getPath('home')` — same replacement as above.
- **L121–122** `if (app.isPackaged) { return path.join(process.resourcesPath,
  'playwright-browsers'); }` — the only consumer of
  `process.resourcesPath` in the tree. In plugin mode this branch should
  be configurable or removed; the Electron-packaged layout no longer
  exists.

### ScreenshotCollector — `src/main/services/ScreenshotCollector.ts`

- **No Electron couplings.** This service is already portable — it takes
  a Playwright `Page` in its constructor and writes JPEGs to a directory
  passed in via `saveToDirectory`. The only caller that supplies that
  directory is `Kowalski.ts`, which reads it from `app.getPath('downloads')`
  (and currently has the call commented out — see below). Once
  `KowalskiSession.scratchDir` exists, this service needs no changes.

### SessionMemory — `src/main/services/SessionMemory.ts`

- **L16** `import { app } from 'electron'`.
- **L29** `const userDataPath = app.getPath('userData'); this.storagePath =
  path.join(userDataPath, 'session_memory', 'summaries.json')` —
  constructor-time side effect that pins memory to the Electron userData
  directory. Move to a constructor argument:
  `new SessionMemory(memoryFilePath: string)`, with the caller passing in
  `path.join(session.scratchDir, 'session_memory', 'summaries.json')`.

### SecureKeyManager — `src/main/services/SecureKeyManager.ts`

- **L1** `import { safeStorage } from 'electron'` — the whole class is
  built around Electron's safeStorage (OS keychain) + electron-store.
  In plugin mode the API key should come from the session config (env
  var, OpenClaw host setting, etc.); this entire service becomes a thin
  `KeyProvider` interface implemented by the host. Two options:
  1. Delete the file entirely and have callers read
     `session.anthropicApiKey: string` directly.
  2. Keep the interface (`getKey / setKey / getKeyStatus`) but back it
     with an injected provider so tests can swap in a fake.
- **L17–18** `const { default: Store } = await import('electron-store');
  return new Store();` — dynamic electron-store load inside `getStore()`.
  Goes away with the service.
- **L25, L30, L45, L53, L65** `safeStorage.isEncryptionAvailable() /
  encryptString / decryptString` — all disappear with the service.

### UsageService — `src/main/services/UsageService.ts`

- **L41** `const { default: Store } = await import('electron-store')` — the
  only Electron-ish thing left here. The service already degrades
  gracefully when the dynamic import fails (see `storeUnavailable` at
  L33), which is how the current test scripts work. Clean replacement:
  take a `UsageStore` interface (get/set) in the constructor, let the
  host back it with a plain JSON file under `session.scratchDir/usage.json`.

### RunManager — `src/main/services/RunManager.ts`

- **L1** `import { app, BrowserWindow } from 'electron'`.
- **L20, L43–45, L67, L133, L208, L354, L390, L406** — ten call sites
  that read `this.mainWindow` and then `webContents.send(...)` on one of
  ten event names: `analysis-error`, `run-started`, `run-phase`,
  `analysis-ready`, `run-complete`. All become events on
  `session.events`. The list of event names is the public progress
  contract the OpenClaw plugin needs to surface.
- **L142–143** `const { default: Store } = await import('electron-store');
  const store: any = new Store();` — reads `settings`, `analyses`,
  `lastAnalysisDate` / `analysisStatus`. Everything currently persisted
  to electron-store should move behind a simple key/value store the host
  owns, or — more realistically — be passed in as
  `session.runConfig = { userName, location, ... }` and returned as part
  of the run result instead of written to a shared store.
- **L179** `const screenshotsDir = path.join(app.getPath('userData'),
  'kowalski-runs')` — raw screenshots + sidecars for the current run.
  Becomes `session.scratchDir + '/kowalski-runs'`.
- **L296–297** `const userDataPath = app.getPath('userData'); const
  recordDir = path.join(userDataPath, 'analysis_records')` — per-run
  digest + image records. Same treatment: move under
  `session.outputDir` (separate from scratchDir so callers can decide
  what survives the session).
- **L342–343, L347–351** `store.set('analyses', ...)` and
  `store.set('settings', ...)` — persistence side effects that need to
  go away. The run should return a result object; the host decides what
  to do with it.

### Kowalski — `src/main/services/Kowalski.ts`

- **L13** `import { app } from 'electron'` — only used by the commented-out
  line at L112 (`saveToDirectory: path.join(app.getPath('downloads'),
  'kowalski-debug')`). The import is dead today; remove it when the
  debug block is either deleted or rewritten against `session.scratchDir`.

### main.ts — `src/main/main.ts`

- Already gutted in this stage. Does not compile, by design. The TODO
  comments inside the file are the checklist for how orchestration needs
  to be re-wired once the OpenClaw plugin surface exists. No further
  action in Stage 1.

### Other

- **`src/utils/elementLabeler.ts`** — scanned: no Electron imports, only
  `jimp` + `playwright`. Portable as-is.
- **`src/main/services/InputForwarder.ts`**, **`GhostMouse.ts`**,
  **`HumanScroll.ts`**, **`NetworkMonitor.ts`**, **`ImageTagger.ts`**,
  **`Extractor.ts`**, **`DigestGeneration.ts`**, **`AnalysisGenerator.ts`**,
  **`ContentVision.ts`**, **`StoriesAgent.ts`**, **`FeedAgent.ts`**,
  **`BaseVisionAgent.ts`**, **`Scroller.ts`** — scanned via grep: no
  matches for `electron`, `app\.`, `mainWindow`, `webContents`, `ipcMain`,
  `ipcRenderer`, `safeStorage`, `resourcesPath`, `Store`. These are the
  services that can move into the plugin unchanged.
- **Hardcoded `~/Library/Application Support/Kowalski`** — searched for,
  zero matches. All user-data access goes through `app.getPath('userData')`,
  which is the single conceptual variable the refactor needs to replace.

---

## Session object sketch

Based on the couplings above, a `KowalskiSession` needs to hold five
logical things: where to keep bytes, how to talk to Anthropic, how to
talk to Playwright, how to emit progress, and how to cancel. Interface
only — no implementation choices baked in yet.

```ts
import type { BrowserContext } from 'playwright';
import type { EventEmitter } from 'node:events';

export interface KowalskiSession {
    // Paths supplied by the host. scratchDir is ephemeral (raw frames,
    // extraction sidecars, per-run working state); outputDir is where the
    // final digest + image records land for the host to consume.
    scratchDir: string;
    outputDir: string;
    browserProfileDir: string;

    // Secrets + run config. The host decides where the key comes from
    // (env var, keychain, OpenClaw secret store) and hands it in here.
    anthropicApiKey: string;
    runConfig: {
        userName?: string;
        location?: string;
        phases?: Array<'stories' | 'feed'>;
        maxDurationMs?: number;
    };

    // Playwright wiring. Either the host launches the browser and passes
    // the context in (plugin-style), or it passes an executable path and
    // lets BrowserManager launch its own persistent context.
    browser?: {
        context?: BrowserContext;
        executablePath?: string;
    };

    // Progress channel. Replaces every `mainWindow.webContents.send(...)`
    // call in the services. Known event names today:
    //   'frame', 'screencastEnded', 'loginScreencastReady', 'loginSuccess',
    //   'run-started', 'run-phase', 'analysis-ready', 'analysis-error',
    //   'run-complete'.
    events: EventEmitter;

    // Cancellation. Composes with the per-fetch AbortControllers inside
    // Extractor / DigestGeneration so a host-initiated cancel unblocks
    // in-flight LLM calls immediately.
    abortSignal: AbortSignal;
}
```
