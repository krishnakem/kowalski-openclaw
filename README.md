# Kowalski — OpenClaw plugin

Kowalski is an [OpenClaw](https://openclaw.ai) plugin that captures your Instagram stories + feed and returns a markdown digest. You ask your OpenClaw agent _"what's happening on my feed today?"_, it triggers this plugin, the plugin drives Chromium + OpenClaw's configured model provider through your home page, and you get back a readable summary instead of having to scroll.

The heavy lifting is all local — real Playwright-controlled Chromium against a real session cookie, vision-agent loops at every browsing step (login, stories, feed), structured extraction per capture, and finally a deterministic text-only digest writer over those extractions. No scraping, no undocumented APIs, just a browser driven by a model.

> **Status — OpenClaw-native.** Kowalski is now a pure OpenClaw plugin: Playwright browser automation plus model calls routed through `api.runtime`, wired to an OpenClaw `register(api)` entrypoint. See [REFACTOR_NOTES.md](REFACTOR_NOTES.md) for the full refactor history, architectural trade-offs, and known risks.

---

## Table of contents

- [What the plugin exposes](#what-the-plugin-exposes)
- [Artifacts and TUI output](#artifacts-and-tui-output)
- [Architecture](#architecture)
- [Agentic login (Stage 6)](#agentic-login-stage-6)
- [Installation into OpenClaw](#installation-into-openclaw)
- [Configuration](#configuration)
- [Bundled browser](#bundled-browser)
- [Project layout](#project-layout)
- [Models and costs](#models-and-costs)
- [Development](#development)
- [Disclaimer](#disclaimer)

---

## What the plugin exposes

The plugin registers **eleven tools** on the OpenClaw agent surface. The [skills](skills/) playbooks tell the agent how to run digests, adjust timers, and answer remaining-time questions.

| Tool | Purpose |
| --- | --- |
| `start_session` | Create a Kowalski session for the requested duration and automatically continue: valid cookie starts the digest in the background; missing/unknown cookie starts the headless login flow and returns the relevant pending state if user input is needed. |
| `login` | Continue the automatic headless login flow. If credentials are missing, returns `pending_credentials`; if Instagram asks for 2FA/device approval, returns `pending_2fa` / `pending_device_approval`; when login is verified, starts the digest in the background. |
| `submit_verification_code` | Second leg of the login round-trip. Accepts a 2FA code or polls for device approval when `code: null`; when verification succeeds, starts the digest in the background. |
| `update_timer` | Change a session's requested duration. Before capture starts, recomputes the 30/70 stories/feed-posts split. During a live run, stories keeps its original cap and changed time goes to feed/posts; if elapsed time already meets the new timer, the run stops and finalizes a partial digest if captures exist. |
| `run_digest` | Manually run stories + feed capture, extraction, digest generation, PDF export, and return the display-ready markdown in the tool result. Normally `start_session` or successful login starts the digest in the background for you. Bounded by the user-requested duration: 30% stories, 70% feed/posts when both phases run. |
| `get_session_status` | Latest run phase + the last ~20 pipeline events. When the digest is ready, tells the agent to call `print_digest`. |
| `print_digest` | Polls for the completed/stopped digest. While still running, returns a silent pending payload; once ready, returns display-ready markdown, preserving emoji, and auto-ends the session after printing. With no args, prints the newest ready in-memory digest or newest saved analysis record. |
| `reset_memory` | Delete the cross-run session-memory JSON so the next run starts from a clean slate. |
| `reset_all` | Dry-run-first factory reset for browser profile, scratch data, and output records. Requires `confirm: true` to actually wipe. |
| `stop_run` | Global stop switch. With a session id it targets that session; with a missing/stale id it still writes the plugin-level stop marker that `RunManager` polls every ~3s. The run finalizes with a partial digest/PDF tagged `abortReason: user-stop` when captures exist; call `get_session_status` or `print_digest` after finalization to show it. |
| `end_session` | Abort the in-flight run, close the Playwright context, drop the `session_id`. |

The canonical happy-path call chain for a digest ask is now `start_session → wait for an explicit status/result request → get_session_status or print_digest`. Manual `run_digest` calls instead block until completion and return the display-ready digest directly. If login needs credentials, 2FA, or device approval, the pending response tells the agent which user input is needed before the workflow resumes. Scheduled 30-second `print_digest` checks are disabled by default unless `enableScheduledPolling` is configured and the OpenClaw gateway has a delivery channel.

---

## Artifacts and TUI output

Every completed, stopped, or best-effort partial run attempts to produce:

- A JSON analysis record under `~/.kowalski/output/analysis_records/<id>.json`.
- Per-record image artifacts under `~/.kowalski/output/analysis_records/<id>/images/`.
- A text-only PDF, defaulting to `~/Downloads/kowalski-digest-<timestamp>.pdf`.
- Display-ready markdown for the TUI.

Manual `run_digest` returns that markdown directly in the tool result after
writing the JSON/PDF artifacts. The normal `start_session` and login/2FA flows
start the digest in the background, so the agent should call
`get_session_status` or `print_digest` when the user asks for progress or the
result. A configured-channel client may opt into silent scheduled
`print_digest` checks with `enableScheduledPolling`, but that is not the
default workflow.

`stop_run` stops collecting more Instagram content but does not discard the
run. If captures exist, Kowalski finalizes a partial digest/PDF tagged
`abortReason: user-stop`; call `get_session_status` or `print_digest` after
the stop finalizes to show the partial digest.

`print_digest` can be called with a `session_id`, with a `record_id`, or with no
arguments. With no arguments, it prints the newest ready in-memory digest or the
newest saved analysis record.

---

## Architecture

Kowalski is structured as a **four-stage pipeline of vision agents**, all sharing the same `BaseVisionAgent` abstract class (observe → label elements → ask OpenClaw runtime → execute action → repeat). Agents communicate through the filesystem, not in-memory state, so a slow or stuck stage never blocks another.

```
        ┌──────────────────────────────────────────────────────────────────┐
        │  OpenClaw agent (in chat)                                        │
        │    ↓ calls tools                                                 │
        │  src/plugin/index.ts  ──────────  registers 11 tools             │
        └──────────────────────────┬───────────────────────────────────────┘
                                   │ (session_id + runConfig)
                                   ▼
            ┌─────────────────────────────────────────────────┐
            │  KowalskiSession  (src/core/KowalskiSession.ts) │
            │    scratchDir, outputDir, browserProfileDir,    │
            │    inferenceClient, runConfig, events, abort    │
            └─────────────────────────────────────────────────┘
                                   │
        ┌──────────────────────────┼───────────────────────────────────────┐
        │  Services (src/main/services/) — bound to the active session    │
        │                                                                  │
        │  LoginAgent      (Stage 6 — typed credentials, 2FA round-trip)  │
        │      │                                                           │
        │      ▼  on success, sessionid cookie persisted                   │
        │  StoriesAgent    (Phase 1 — stories viewer, auto-pause)          │
        │  FeedAgent       (Phase 2 — posts, carousels, popup dismissal)   │
        │      │                                                           │
        │      ▼  writes raw/*.jpg + sidecar JSON per meaningful frame     │
        │  Extractor       (Phase 2.5 — one vision call per capture,       │
        │                   merges structured extraction into sidecars)    │
        │      │                                                           │
        │      ▼  reads sidecars as text only                              │
        │  DigestGeneration (Phase 3 — local extractive writer)            │
        │      │                                                           │
        │      ▼                                                           │
        │  RunManager writes analysis_records/<id>.json + PDF artifact     │
        └──────────────────────────────────────────────────────────────────┘
```

Pieces worth calling out:

- **[BaseVisionAgent](src/main/services/BaseVisionAgent.ts)** — abstract superclass shared by `LoginAgent`, `StoriesAgent`, `FeedAgent`. Handles screenshot capture, element labelling (Set-of-Mark overlay), OpenClaw runtime model calls, action dispatch, reference-image injection, and per-turn debug dumps.
- **[elementLabeler](src/utils/elementLabeler.ts)** — draws numbered badges over interactive elements on the screenshot server-side (Jimp). No DOM injection, so it doesn't trip Instagram's bot checks.
- **[BrowserManager](src/main/services/BrowserManager.ts)** — singleton, always headless, launches the plugin-local Playwright Chromium with an explicit `executablePath`, and applies stealth init scripts on every context. It does not fall back to system Chrome or a user-level Playwright cache.
- **[GhostMouse](src/main/services/GhostMouse.ts)** + **[HumanScroll](src/main/services/HumanScroll.ts)** — human-rhythm input. Direct `page.mouse` calls; CDP for scroll-position reads so state queries don't show up as `page.evaluate` injections.
- **[RunManager](src/main/services/RunManager.ts)** — run lifecycle. Multi-probe offline watchdog, per-phase hard timeouts, cooperative stop via `STOP_REQUESTED` marker file, partial-record writes on abort, and digest record persistence.
- **[SessionMemory](src/main/services/SessionMemory.ts)** — cross-session digest of which accounts / phases / recoveries worked. Read into the next run's navigator context.
- **[cookie-probe](src/plugin/cookie-probe.ts)** — reads the Instagram `sessionid` cookie directly out of the Chromium profile's SQLite `Cookies` DB. No auth flow needed to check "am I logged in?".

---

## Agentic login (Stage 6)

The defining piece of the project is that **login itself is driven by a vision agent**, not a scripted selector-based flow. `LoginAgent` extends the same `BaseVisionAgent` the capture phases use — it's just a different prompt ([login-instructions.md](src/main/prompts/login-instructions.md)) and a few login-specific actions.

**Scene classification.** Every turn starts by identifying the scene: `logged_out_landing`, `save_info_interstitial`, `two_factor_code`, `device_approval`, `suspicious_login_challenge`, `home_feed`, etc. Branching happens in the prompt based on what the agent sees.

**Credential values never touch the LLM.** The prompt emits `fill_username` / `fill_password` actions; the executor reads values seeded from `IG_USERNAME` / `IG_PASSWORD` environment variables into `session.runConfig.igUsername` / `igPassword` and types them into the focused field character-by-character with 80–220 ms jitter. The model payload for that turn contains only the action name, and the `login` tool does not accept username/password parameters.

**2FA round-trip.** When the agent sees a 2FA screen, it emits `emit_pending_2fa`, halts, and the `login` tool returns `{ status: 'pending_2fa', login_id }` with a `PendingLogin` keeping the Playwright page alive. The OpenClaw agent asks the user for their code in chat, the user replies, the agent calls `submit_verification_code(login_id, code)`, and the `LoginAgent` resumes against the same page with the code threaded into its user prompt. When verification succeeds, the digest starts automatically.

**Device-approval round-trip.** For "we sent a notification to your other device" challenges, the agent emits `emit_pending_device_approval` (quoting which device IG named). `submit_verification_code` with `code: null` polls `probeInstagramLogin` every 3s for up to 120s, waiting for the post-approval transition. When approval succeeds, the digest starts automatically.

**Manual-needed outcome.** When agentic login can't resolve the flow — suspicious-login challenge, three consecutive stuck turns, or another checkpoint that cannot be cleared headlessly — the plugin closes the headless context and returns `login_failed_needs_manual`. The agent should ask the user to approve or clear the challenge from the Instagram app on their phone, then retry login later.

**Run traces.** Every agentic login attempt writes per-turn screenshots + metadata into `${session.scratchDir}/kowalski-runs/login_<timestamp>/`. Debuggable after the fact without burning a fresh real-account attempt.

See [REFACTOR_NOTES.md › Stage 6](REFACTOR_NOTES.md) for the full design trade-offs.

---

## Installation into OpenClaw

The plugin is loaded directly from this repo as a live-linked plugin — no build step, no published npm package. The OpenClaw loader reads the `openclaw.extensions` field in this repo's `package.json` and imports TypeScript directly.

```bash
# 1. Install the OpenClaw gateway if you haven't already (user-level, no sudo).
npm install -g openclaw

# 2. One-time setup wizard. Pick Gateway mode and configure a provider/model.
#    Kowalski defaults to OpenClaw's configured provider and needs a
#    vision-capable image model for screenshots.
openclaw configure

# 3. (Optional) Set IG credentials for agentic login. If unset, the
#    `login` tool returns pending_credentials with env setup instructions.
export IG_USERNAME="your.instagram.handle"
export IG_PASSWORD="your.password"

#    Optional alternative: inject an existing Instagram session cookie without
#    passing it through chat/tool params. Use either the raw value or
#    "sessionid=..." copied from a Cookie header.
export IG_SESSIONID="your.instagram.sessionid"

# 4. Install plugin dependencies and the plugin-local Playwright browser.
cd /absolute/path/to/Kowalski-OpenClaw
npm install
npm run check:browser

# 5. Install this repo as a live-linked plugin. --link symlinks the
#    working tree so edits show up on the next gateway restart.
openclaw plugins install /absolute/path/to/Kowalski-OpenClaw \
  --link \
  --dangerously-force-unsafe-install

# 6. Run the gateway, then attach the TUI in another shell.
openclaw gateway run
openclaw tui
```

The `--dangerously-force-unsafe-install` flag is required because OpenClaw's static scanner can flag process-env reads near model-call paths as potential "credential harvesting" false positives. Kowalski reads environment variables only for optional runtime controls and Instagram login convenience; model credentials come from OpenClaw's configured provider.

**Gateway reloads are NOT automatic.** After editing plugin code, `Ctrl-C` the `openclaw gateway run` process and start it again. `--link` only means source edits in this repo are picked up on the next boot — the gateway itself doesn't hot-reload.

---

## Configuration

### Plugin config (set via `openclaw config set`)

| Key | Required | Default |
| --- | --- | --- |
| `browserProfileDir` | no | `~/.kowalski/browser` |
| `scratchDir` | no | `~/.kowalski/scratch` |
| `outputDir` | no | `~/.kowalski/output` |
| `userName` | no | — |
| `location` | no | — |
| `enableScheduledPolling` | no | `false` |

All model calls use OpenClaw's configured provider through `api.runtime`.
Kowalski requires a vision-capable image model. If screenshots cannot be
understood, configure `agents.defaults.imageModel` to a model with image input
support.

PDF export writes to `~/Downloads` by default. The PDF writer also honors a
host-provided `downloadsDir` plugin config value, but the current plugin
manifest does not expose that key in its public config schema.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `IG_USERNAME`, `IG_PASSWORD` | Enable the headless agentic login path ([LoginAgent](src/main/services/LoginAgent.ts)). If either is unset, the `login` tool returns `pending_credentials`. Credentials are never logged, accepted as tool params, or passed through any LLM payload. |
| `IG_SESSIONID`, `INSTAGRAM_SESSIONID` | Optional existing Instagram `sessionid` cookie. If present, Kowalski injects it into the Playwright browser context from env instead of reading plaintext cookie JSON from disk. |
| `KOWALSKI_CONNECTIVITY_PROBE_URLS` | Optional comma-separated connectivity probes for the offline watchdog. Defaults to `https://www.gstatic.com/generate_204`, `https://www.cloudflare.com/cdn-cgi/generate_204`, and `https://www.instagram.com/`. |
| `KOWALSKI_CONNECTIVITY_PROBE_URL` | Back-compat single probe URL. Ignored when `KOWALSKI_CONNECTIVITY_PROBE_URLS` is set. |
| `KOWALSKI_CONNECTIVITY_PROBE_TIMEOUT_MS` | Per-probe timeout. Defaults to `4000`. |
| `KOWALSKI_OFFLINE_WATCHDOG_FAILURES` | Consecutive failed multi-probe rounds before a run is considered offline. Defaults to `6`. |
Model selection is handled by OpenClaw. Configure the default text and image
models in OpenClaw, including `agents.defaults.imageModel` for screenshots.

### Session `runConfig` (threaded through [KowalskiSession](src/core/KowalskiSession.ts))

| Field | Default | Notes |
| --- | --- | --- |
| `phases` | `['stories', 'feed']` | Selectable via `start_session` params. `"just stories"` / `"just feed"` are supported one-word asks in [SKILL.md](skills/instagram-digest/SKILL.md). |
| `maxDurationMs` | from `duration_minutes` | Overall user-requested capture budget. |
| `storiesTimeoutMs` | `30%` of `maxDurationMs` | Hard cap on the stories phase when both phases run. If only stories run, stories get the full requested duration. |
| `feedTimeoutMs` | `70%` of `maxDurationMs` | Hard cap on the feed/posts phase when both phases run. If only feed runs, feed gets the full requested duration. |
| `igUsername`, `igPassword` | (from env) | Stage 6 credentials — see above. |

---

## Project layout

```
src/
├── core/
│   └── KowalskiSession.ts          # Host-supplied session handle
│                                   # (paths, inference client, runConfig, events, abort signal)
├── plugin/                         # OpenClaw plugin surface
│   ├── index.ts                    # register(api) — the 11 tools
│   ├── cookie-probe.ts             # Read Instagram sessionid out of Chromium cookies DB
│   └── session-registry.ts         # Per-session event buffer for get_session_status
├── main/
│   ├── prompts/                    # Markdown prompts shipped to the agents
│   │   ├── capabilities.md
│   │   ├── navigator-agent.md
│   │   ├── stories-instructions.md
│   │   ├── feed-instructions.md
│   │   ├── login-instructions.md   # Stage 6 — scene list + login actions
│   │   └── examples/               # Reference screenshots per phase
│   └── services/
│       ├── BaseVisionAgent.ts      # Abstract observe→label→model→act loop
│       ├── LoginAgent.ts           # Stage 6 — agentic IG login
│       ├── StoriesAgent.ts         # Phase 1 — stories viewer
│       ├── FeedAgent.ts            # Phase 2 — feed + post modals + carousels
│       ├── Extractor.ts            # Phase 2.5 — per-image structured extraction
│       ├── DigestGeneration.ts     # Phase 3 — local extractive digest
│       ├── AnalysisGenerator.ts    # Insights pass over a digest
│       ├── ContentVision.ts        # Shared vision-call helpers
│       ├── ImageTagger.ts          # Per-image tagging utilities
│       ├── Kowalski.ts             # Phase orchestrator (stories → feed)
│       ├── RunManager.ts           # Singleton — lifecycle, offline, stop-marker, timeouts
│       ├── BrowserManager.ts       # Singleton — Playwright + stealth
│       ├── ScreenshotCollector.ts  # raw/ + sidecar writer, session_log.md
│       ├── SessionMemory.ts        # Cross-session learning digest
│       ├── NetworkMonitor.ts       # Offline watchdog + error classification
│       ├── GhostMouse.ts           # Direct page.mouse mouse input
│       ├── HumanScroll.ts          # CDP-based scroll with failure detection
│       ├── Scroller.ts             # Lower-level scroll primitives
│       ├── InputForwarder.ts       # Keyboard input wrapper
│       ├── UsageService.ts         # Token + cost accounting
│       └── ChromiumVersionHelper.ts
├── shared/
│   ├── modelConfig.ts              # Legacy model hints for non-runtime callers
│   └── viewportConfig.ts           # Shared viewport dimensions
├── utils/
│   └── elementLabeler.ts           # Set-of-Mark overlay + viewport-space bbox map
└── types/                          # analysis, instagram, navigation, session-memory, better-sqlite3

scripts/                            # npm run test:* harnesses
├── test-digest.ts                  # Digest generation test
├── test-extract.ts                 # Extractor test
├── test-inference-factory.ts       # OpenClaw runtime inference adapter smoke
├── test-run.ts                     # Full pipeline test (headless)
├── test-plugin.ts                  # Plugin surface smoke (npm run test:plugin)
├── test-login-agent.ts             # LoginAgent smoke against a fake IG fixture (npm run test:login)
├── test-bundled-browser-resolver.ts # Browser executable resolver test
├── test-pdf.ts                     # PDF export smoke helper
└── fixtures/
    └── fake-ig-login.html          # Static IG-login-alike for test:login

skills/
├── instagram-digest/
│   └── SKILL.md                    # Main digest playbook (what to call, when)
├── kowalski-timer/
│   └── SKILL.md                    # Timer-change playbook
└── kowalski-time-remaining/
    └── SKILL.md                    # Remaining-time status playbook
```

---

## Models and costs

OpenClaw's configured runtime chooses the models:

- Screenshot understanding and structured extraction go through
  `api.runtime.mediaUnderstanding`.
- Digest assembly is local and deterministic over extractor sidecars; it does
  not call a final text model.

Kowalski does not currently force specific model IDs from inside the plugin.
Configure the image model in OpenClaw; screenshot understanding requires a
vision-capable image model such as `agents.defaults.imageModel`.

Costs depend on your provider, selected models, and how many screenshots/agent
turns a run needs. The plugin records provider/model/usage when the runtime
returns them.

Duration is chosen at the start of the run. The OpenClaw skill asks how many
minutes the user wants, then passes `duration_minutes` to `start_session`. When
both phases run, Kowalski splits that budget 30/70: stories get 30%, and
feed/posts get 70%. If a phase hits its cap, Kowalski finalizes with a partial
digest tagged with the timeout reason.

## Bundled Browser

Kowalski uses a plugin-local Playwright Chromium/headless-shell install created
by `npm install` or repaired with `npm run setup:browser`:

```text
node_modules/playwright-core/.local-browsers
```

Runtime always passes this executable path to Playwright. It does not use
system Chrome, another project's Chromium, or the user-level Playwright cache.
If the local browser is missing, launch fails and asks you to run the repair
command.

```bash
npm run setup:browser   # install/repair the plugin-local browser
npm run check:browser   # verify the executable path + revision
```

On Linux, the host may still need the shared libraries required by
Playwright/Chromium.

---

## Development

```bash
npm install
npm run check:browser   # Confirm plugin-local Chromium exists
npx tsc --noEmit        # Typecheck

npm run test:browser-resolver
npm run test:plugin     # Plugin surface — asserts 11 tools registered in order
npm run test:login      # LoginAgent against a local fake-IG fixture
                        # (scripted callLLM — no provider calls)
npm run test:inference  # OpenClaw runtime inference adapter smoke
npm run test:extract    # Skips: extraction requires OpenClaw plugin runtime
npm run test:digest     # Skips: digest generation requires OpenClaw plugin runtime
npm run test:run        # Skips: full run requires OpenClaw plugin runtime
npm run lint
```

The plugin loads TypeScript directly — the OpenClaw loader consumes `src/plugin/index.ts` with no build step and no `dist/` output. Edits to any file in this tree are picked up on the next `openclaw gateway run` boot (provided the plugin was installed with `--link`).

---

## Disclaimer

Instagram's terms of service prohibit automated access, and Instagram actively works to prevent AI agents and bots from using the platform. Running Kowalski may result in rate limiting, challenges, temporary restrictions, or permanent suspension of your Instagram account.

**Use of Kowalski is entirely at your own risk.** I am not responsible for any consequences that arise from running this software, including but not limited to account bans, data loss, API costs, or any other issues. This is an experimental personal project provided as-is, with no warranty of any kind.
