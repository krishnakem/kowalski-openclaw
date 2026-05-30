# Kowalski — OpenClaw plugin

Kowalski is an [OpenClaw](https://openclaw.ai) plugin that captures your Instagram stories + feed and returns a markdown digest. You ask your OpenClaw agent _"what's happening on my feed today?"_, it triggers this plugin, the plugin drives Chromium + OpenClaw's configured model provider through your home page, and you get back a readable summary instead of having to scroll.

The heavy lifting is all local — real Playwright-controlled Chromium against a real session cookie, vision-agent loops at every step (login, stories, feed), structured extraction per capture, and finally a text-only digest writer. No scraping, no undocumented APIs, just a browser driven by a model.

> **Status — OpenClaw-native.** Kowalski is now a pure OpenClaw plugin: Playwright browser automation plus model calls routed through `api.runtime`, wired to an OpenClaw `register(api)` entrypoint. See [REFACTOR_NOTES.md](REFACTOR_NOTES.md) for the full refactor history, architectural trade-offs, and known risks.

---

## Table of contents

- [What the plugin exposes](#what-the-plugin-exposes)
- [Architecture](#architecture)
- [Agentic login (Stage 6)](#agentic-login-stage-6)
- [Installation into OpenClaw](#installation-into-openclaw)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Models and costs](#models-and-costs)
- [Development](#development)
- [Disclaimer](#disclaimer)

---

## What the plugin exposes

The plugin registers **eleven tools** on the OpenClaw agent surface. A [SKILL.md](skills/instagram-digest/SKILL.md) playbook tells the agent how to handle the few states that still need user input.

| Tool | Purpose |
| --- | --- |
| `start_session` | Create a Kowalski session and automatically continue: valid cookie starts `run_digest`; missing/unknown cookie starts the headless login flow and returns the relevant pending state if user input is needed. |
| `login` | Continue the automatic headless login flow. If credentials are missing, returns `pending_credentials`; if Instagram asks for 2FA/device approval, returns `pending_2fa` / `pending_device_approval`; when login is verified, starts `run_digest` automatically. |
| `submit_verification_code` | Second leg of the login round-trip. Accepts a 2FA code or polls for device approval when `code: null`; when verification succeeds, starts `run_digest` automatically. |
| `run_digest` | Manually start the non-blocking stories + feed capture, extraction, and digest generation run. Normally `start_session` or successful login starts this for you. Bounded by hard per-phase timeouts (15 min stories, 30 min feed). |
| `get_session_status` | Latest run phase + the last ~20 pipeline events. Also delivers the final digest once `digest_status` is `completed` or `stopped`. |
| `reset_memory` | Delete the cross-run session-memory JSON so the next run starts from a clean slate. |
| `reset_all` | Dry-run-first factory reset for browser profile, scratch data, and output records. Requires `confirm: true` to actually wipe. |
| `stop_run` | Global stop switch. With a session id it targets that session; with a missing/stale id it still writes the plugin-level stop marker that `RunManager` polls every ~3s. The run finalizes at the next phase checkpoint and produces a partial digest tagged `abortReason: user-stop`. |
| `end_session` | Abort the in-flight run, close the Playwright context, drop the `session_id`. |

The canonical happy-path call chain for a digest ask is now just `start_session → get_session_status when the user asks if it is done`. If login needs credentials, 2FA, or device approval, the pending response tells the agent which one user input is needed before the workflow resumes.

---

## Architecture

Kowalski is structured as a **four-stage pipeline of vision agents**, all sharing the same `BaseVisionAgent` abstract class (observe → label elements → ask OpenClaw runtime → execute action → repeat). Agents communicate through the filesystem, not in-memory state, so a slow or stuck stage never blocks another.

```
        ┌──────────────────────────────────────────────────────────────────┐
        │  OpenClaw agent (in chat)                                        │
        │    ↓ calls tools                                                 │
        │  src/plugin/index.ts  ──────────  registers 9 tools              │
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
        │  DigestGeneration (Phase 3 — OpenClaw text model)                │
        │      │                                                           │
        │      ▼                                                           │
        │  AnalysisGenerator → analysis_records/<id>.json                  │
        └──────────────────────────────────────────────────────────────────┘
```

Pieces worth calling out:

- **[BaseVisionAgent](src/main/services/BaseVisionAgent.ts)** — abstract superclass shared by `LoginAgent`, `StoriesAgent`, `FeedAgent`. Handles screenshot capture, element labelling (Set-of-Mark overlay), OpenClaw runtime model calls, action dispatch, reference-image injection, and per-turn debug dumps.
- **[elementLabeler](src/utils/elementLabeler.ts)** — draws numbered badges over interactive elements on the screenshot server-side (Jimp). No DOM injection, so it doesn't trip Instagram's bot checks.
- **[BrowserManager](src/main/services/BrowserManager.ts)** — singleton, always headless, launches the plugin-local Playwright Chromium with an explicit `executablePath`, and applies stealth init scripts on every context. It does not fall back to system Chrome or a user-level Playwright cache.
- **[GhostMouse](src/main/services/GhostMouse.ts)** + **[HumanScroll](src/main/services/HumanScroll.ts)** — human-rhythm input. Direct `page.mouse` calls; CDP for scroll-position reads so state queries don't show up as `page.evaluate` injections.
- **[RunManager](src/main/services/RunManager.ts)** — run lifecycle. Offline watchdog (3-strike), per-phase hard timeouts, cooperative stop via `STOP_REQUESTED` marker file, partial-record writes on abort.
- **[SessionMemory](src/main/services/SessionMemory.ts)** — cross-session digest of which accounts / phases / recoveries worked. Read into the next run's navigator context.
- **[cookie-probe](src/plugin/cookie-probe.ts)** — reads the Instagram `sessionid` cookie directly out of the Chromium profile's SQLite `Cookies` DB. No auth flow needed to check "am I logged in?".

---

## Agentic login (Stage 6)

The defining piece of the project is that **login itself is driven by a vision agent**, not a scripted selector-based flow. `LoginAgent` extends the same `BaseVisionAgent` the capture phases use — it's just a different prompt ([login-instructions.md](src/main/prompts/login-instructions.md)) and a few login-specific actions.

**Scene classification.** Every turn starts by identifying the scene: `logged_out_landing`, `save_info_interstitial`, `two_factor_code`, `device_approval`, `suspicious_login_challenge`, `home_feed`, etc. Branching happens in the prompt based on what the agent sees.

**Credentials never touch the LLM.** The prompt emits `fill_username` / `fill_password` actions; the executor reads the values from `session.runConfig.igUsername` / `igPassword` (which came from env vars) and types them into the focused field character-by-character with 80–220 ms jitter. The model payload for that turn contains only the action name.

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
#    `login` tool returns pending_credentials so the agent can ask in chat.
export IG_USERNAME="your.instagram.handle"
export IG_PASSWORD="your.password"

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

All model calls use OpenClaw's configured provider through `api.runtime`.
Kowalski requires a vision-capable image model. If screenshots cannot be
understood, configure `agents.defaults.imageModel` to a model with image input
support.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `IG_USERNAME`, `IG_PASSWORD` | Enable unattended use of the headless agentic login path ([LoginAgent](src/main/services/LoginAgent.ts)). If either is unset, the `login` tool returns `pending_credentials`. Credentials are never logged or passed through any LLM payload. |
| `KOWALSKI_CONNECTIVITY_PROBE_URL` | Optional URL for the generic offline watchdog probe. Defaults to `https://www.gstatic.com/generate_204`. |

Model selection is handled by OpenClaw. Configure the default text and image
models in OpenClaw, including `agents.defaults.imageModel` for screenshots.

### Session `runConfig` (threaded through [KowalskiSession](src/core/KowalskiSession.ts))

| Field | Default | Notes |
| --- | --- | --- |
| `phases` | `['stories', 'feed']` | Selectable via `start_session` params. `"just stories"` / `"just feed"` are supported one-word asks in [SKILL.md](skills/instagram-digest/SKILL.md). |
| `storiesTimeoutMs` | `15 * 60 * 1000` | Hard cap on the stories phase. Phase installs a `setTimeout` on entry that cooperatively stops the agent. |
| `feedTimeoutMs` | `30 * 60 * 1000` | Same, for feed. |
| `maxDurationMs` | `90 * 60 * 1000` | Overall run budget. |
| `igUsername`, `igPassword` | (from env) | Stage 6 credentials — see above. |

---

## Project layout

```
src/
├── core/
│   └── KowalskiSession.ts          # Host-supplied session handle
│                                   # (paths, inference client, runConfig, events, abort signal)
├── plugin/                         # OpenClaw plugin surface
│   ├── index.ts                    # register(api) — the 9 tools
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
│       ├── DigestGeneration.ts     # Phase 3 — text-only editorial
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
├── test-run.ts                     # Full pipeline test (headless)
├── test-plugin.ts                  # Plugin surface smoke (npm run test:plugin)
├── test-login-agent.ts             # LoginAgent smoke against a fake IG fixture (npm run test:login)
└── fixtures/
    └── fake-ig-login.html          # Static IG-login-alike for test:login

skills/
└── instagram-digest/
    └── SKILL.md                    # OpenClaw skill playbook (what to call, when)
```

---

## Models and costs

OpenClaw's configured runtime chooses the models:

- Screenshot understanding goes through `api.runtime.mediaUnderstanding`.
- Text-only generation goes through `api.runtime.llm.complete`.

Kowalski does not currently force specific model IDs from inside the plugin.
Configure the text and image models in OpenClaw; screenshot understanding
requires a vision-capable image model such as `agents.defaults.imageModel`.

Costs depend on your provider, selected models, and how many screenshots/agent
turns a run needs. The plugin records provider/model/usage when the runtime
returns them.

Duration is bounded by the pipeline timeouts: stories cap at 15 minutes, feed
caps at 30 minutes, so a full run can take up to about 45 minutes before it
finalizes with a partial digest.

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
npm run test:plugin     # Plugin surface — asserts 9 tools registered in order
npm run test:login      # LoginAgent against a local fake-IG fixture
                        # (scripted callLLM — no provider calls)
npm run test:extract    # Skips: extraction requires OpenClaw plugin runtime
npm run test:digest     # Skips: digest generation requires OpenClaw plugin runtime
npm run test:run        # Skips: full run requires OpenClaw plugin runtime
```

The plugin loads TypeScript directly — the OpenClaw loader consumes `src/plugin/index.ts` with no build step and no `dist/` output. Edits to any file in this tree are picked up on the next `openclaw gateway run` boot (provided the plugin was installed with `--link`).

---

## Disclaimer

Instagram's terms of service prohibit automated access, and Instagram actively works to prevent AI agents and bots from using the platform. Running Kowalski may result in rate limiting, challenges, temporary restrictions, or permanent suspension of your Instagram account.

**Use of Kowalski is entirely at your own risk.** I am not responsible for any consequences that arise from running this software, including but not limited to account bans, data loss, API costs, or any other issues. This is an experimental personal project provided as-is, with no warranty of any kind.
