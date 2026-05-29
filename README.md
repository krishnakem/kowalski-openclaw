# Kowalski — OpenClaw plugin

Kowalski is an [OpenClaw](https://openclaw.ai) plugin that captures your Instagram stories + feed and returns a markdown digest. You ask your OpenClaw agent _"what's happening on my feed today?"_, it triggers this plugin, the plugin drives Chromium + Claude vision agents through your home page, and you get back a readable summary instead of having to scroll.

The heavy lifting is all local — real Playwright-controlled Chromium against a real session cookie, vision-agent loops at every step (login, stories, feed), structured extraction per capture, and finally a text-only digest writer. No scraping, no undocumented APIs, just a browser driven by a model.

> **Status — refactor complete.** This repo started as a standalone Electron desktop app and was refactored through six stages into a pure OpenClaw plugin. The Electron shell / React UI / IPC layer are gone; only the Playwright + Claude pipeline remains, wired to an OpenClaw `register(api)` entrypoint. See [REFACTOR_NOTES.md](REFACTOR_NOTES.md) for the full stage-by-stage history, including architectural trade-offs and known risks.

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

The plugin registers **eight tools** on the OpenClaw agent surface. A [SKILL.md](skills/instagram-digest/SKILL.md) playbook tells the agent which tools to call in which order for typical requests.

| Tool | Purpose |
| --- | --- |
| `start_session` | Create a Kowalski session, probe whether the persistent browser profile is still logged in, return a `session_id` used by every other tool. |
| `login` | Log into Instagram with the headless agentic [LoginAgent](src/main/services/LoginAgent.ts) loop. If credentials are not already available from params or `IG_USERNAME` / `IG_PASSWORD`, returns `pending_credentials` so the agent can ask in chat. Can return `pending_2fa`, `pending_device_approval`, or `login_failed_needs_manual`. |
| `submit_verification_code` | Second leg of the login round-trip. Accepts a 2FA code and resumes the agent, or polls for device approval when `code: null`. |
| `run_digest` | Single blocking call that runs stories + feed capture, extraction, and digest generation. Returns the digest markdown. Bounded by hard per-phase timeouts (15 min stories, 30 min feed). |
| `get_session_status` | Latest run phase + the last ~20 pipeline events. Useful between runs (OpenClaw typically serializes tool calls per session, so live polling during `run_digest` won't fire until the run returns). |
| `reset_memory` | Delete the cross-run session-memory JSON so the next run starts from a clean slate. |
| `stop_run` | Write a stop marker that `RunManager` polls every ~3s. The run finalizes at the next phase checkpoint and produces a partial digest tagged `abortReason: user-stop`. |
| `end_session` | Abort the in-flight run, close the Playwright context, drop the `session_id`. |

The canonical happy-path call chain for a digest ask: `start_session → login (if logged_in: false) → run_digest → end_session`.

---

## Architecture

Kowalski is structured as a **four-stage pipeline of vision agents**, all sharing the same `BaseVisionAgent` abstract class (observe → label elements → ask Claude → execute action → repeat). Agents communicate through the filesystem, not in-memory state, so a slow or stuck stage never blocks another.

```
        ┌──────────────────────────────────────────────────────────────────┐
        │  OpenClaw agent (in chat)                                        │
        │    ↓ calls tools                                                 │
        │  src/plugin/index.ts  ──────────  registers 8 tools              │
        └──────────────────────────┬───────────────────────────────────────┘
                                   │ (session_id + runConfig)
                                   ▼
            ┌─────────────────────────────────────────────────┐
            │  KowalskiSession  (src/core/KowalskiSession.ts) │
            │    scratchDir, outputDir, browserProfileDir,    │
            │    anthropicApiKey, runConfig, events, abort    │
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
        │  DigestGeneration (Phase 3 — Haiku-by-default editorial)         │
        │      │                                                           │
        │      ▼                                                           │
        │  AnalysisGenerator → analysis_records/<id>.json                  │
        └──────────────────────────────────────────────────────────────────┘
```

Pieces worth calling out:

- **[BaseVisionAgent](src/main/services/BaseVisionAgent.ts)** — abstract superclass shared by `LoginAgent`, `StoriesAgent`, `FeedAgent`. Handles screenshot capture, element labelling (Set-of-Mark overlay), Claude API calls with prompt caching, action dispatch, reference-image injection, and per-turn debug dumps.
- **[elementLabeler](src/utils/elementLabeler.ts)** — draws numbered badges over interactive elements on the screenshot server-side (Jimp). No DOM injection, so it doesn't trip Instagram's bot checks.
- **[BrowserManager](src/main/services/BrowserManager.ts)** — singleton, always headless, `playwright-extra` + stealth plugin, stealth init scripts applied on every context.
- **[GhostMouse](src/main/services/GhostMouse.ts)** + **[HumanScroll](src/main/services/HumanScroll.ts)** — human-rhythm input. Direct `page.mouse` calls; CDP for scroll-position reads so state queries don't show up as `page.evaluate` injections.
- **[RunManager](src/main/services/RunManager.ts)** — run lifecycle. Offline watchdog (3-strike), per-phase hard timeouts, cooperative stop via `STOP_REQUESTED` marker file, partial-record writes on abort.
- **[SessionMemory](src/main/services/SessionMemory.ts)** — cross-session digest of which accounts / phases / recoveries worked. Read into the next run's navigator context.
- **[cookie-probe](src/plugin/cookie-probe.ts)** — reads the Instagram `sessionid` cookie directly out of the Chromium profile's SQLite `Cookies` DB. No auth flow needed to check "am I logged in?".

---

## Agentic login (Stage 6)

The defining piece of the project is that **login itself is driven by a vision agent**, not a scripted selector-based flow. `LoginAgent` extends the same `BaseVisionAgent` the capture phases use — it's just a different prompt ([login-instructions.md](src/main/prompts/login-instructions.md)) and a few login-specific actions.

**Scene classification.** Every turn starts by identifying the scene: `logged_out_landing`, `save_info_interstitial`, `two_factor_code`, `device_approval`, `suspicious_login_challenge`, `home_feed`, etc. Branching happens in the prompt based on what the agent sees.

**Credentials never touch the LLM.** The prompt emits `fill_username` / `fill_password` actions; the executor reads the values from `session.runConfig.igUsername` / `igPassword` (which came from env vars) and types them into the focused field character-by-character with 80–220 ms jitter. The model payload for that turn contains only the action name.

**2FA round-trip.** When the agent sees a 2FA screen, it emits `emit_pending_2fa`, halts, and the `login` tool returns `{ status: 'pending_2fa', login_id }` with a `PendingLogin` keeping the Playwright page alive. The OpenClaw agent asks the user for their code in chat, the user replies, the agent calls `submit_verification_code(login_id, code)`, and the `LoginAgent` resumes against the same page with the code threaded into its user prompt.

**Device-approval round-trip.** For "we sent a notification to your other device" challenges, the agent emits `emit_pending_device_approval` (quoting which device IG named). `submit_verification_code` with `code: null` polls `probeInstagramLogin` every 3s for up to 120s, waiting for the post-approval transition.

**Manual-needed outcome.** When agentic login can't resolve the flow — suspicious-login challenge, three consecutive stuck turns, or another checkpoint that cannot be cleared headlessly — the plugin closes the headless context and returns `login_failed_needs_manual`. The agent should ask the user to approve or clear the challenge from the Instagram app on their phone, then retry login later.

**Run traces.** Every agentic login attempt writes per-turn screenshots + metadata into `${session.scratchDir}/kowalski-runs/login_<timestamp>/`. Debuggable after the fact without burning a fresh real-account attempt.

See [REFACTOR_NOTES.md › Stage 6](REFACTOR_NOTES.md) for the full design trade-offs.

---

## Installation into OpenClaw

The plugin is loaded directly from this repo as a live-linked plugin — no build step, no published npm package. The OpenClaw loader reads the `openclaw.extensions` field in this repo's `package.json` and imports TypeScript directly.

```bash
# 1. Install the OpenClaw gateway if you haven't already (user-level, no sudo).
npm install -g openclaw

# 2. One-time setup wizard. Pick Gateway mode. In the Agent section,
#    pick Anthropic as the provider and claude-sonnet-4-6 as the model.
openclaw configure

# 3. Set the plugin's Anthropic API key BEFORE installing (the loader
#    validates the plugin's configSchema at install time; see
#    REFACTOR_NOTES.md for the chicken-and-egg details).
openclaw config set \
  plugins.entries.kowalski-openclaw.config.anthropicApiKey "sk-ant-…"

# 4. (Optional) Set IG credentials for agentic login. If unset, the
#    `login` tool returns pending_credentials so the agent can ask in chat.
export IG_USERNAME="your.instagram.handle"
export IG_PASSWORD="your.password"

# 5. Install this repo as a live-linked plugin. --link symlinks the
#    working tree so edits show up on the next gateway restart.
openclaw plugins install /absolute/path/to/Kowalski-OpenClaw \
  --link \
  --dangerously-force-unsafe-install

# 6. Run the gateway, then attach the TUI in another shell.
openclaw gateway run
openclaw tui
```

The `--dangerously-force-unsafe-install` flag is required because OpenClaw's static scanner flags three `process.env.*` reads near LLM calls as potential "credential harvesting" false positives. All three reads are a vision-detail feature flag (`KOWALSKI_VISION_DETAIL`), not credentials. See [REFACTOR_NOTES.md › Stage 3.5](REFACTOR_NOTES.md) for details.

**Gateway reloads are NOT automatic.** After editing plugin code, `Ctrl-C` the `openclaw gateway run` process and start it again. `--link` only means source edits in this repo are picked up on the next boot — the gateway itself doesn't hot-reload.

---

## Configuration

### Plugin config (set via `openclaw config set`)

| Key | Required | Default |
| --- | --- | --- |
| `anthropicApiKey` | **yes** | — |
| `browserProfileDir` | no | `~/.kowalski/browser` |
| `scratchDir` | no | `~/.kowalski/scratch` |
| `outputDir` | no | `~/.kowalski/output` |
| `userName` | no | — |
| `location` | no | — |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `IG_USERNAME`, `IG_PASSWORD` | Enable unattended use of the headless agentic login path ([LoginAgent](src/main/services/LoginAgent.ts)). If either is unset, the `login` tool returns `pending_credentials`. Credentials are never logged or passed through any LLM payload. |
| `KOWALSKI_VISION_DETAIL` | `high` (default) or `low`. Controls Anthropic vision detail. |
| `KOWALSKI_STORIES_MODEL` | Stories-phase navigation. Default `claude-sonnet-4-6`. |
| `KOWALSKI_NAV_MODEL` | Feed-phase navigation. Default `claude-sonnet-4-6`. |
| `KOWALSKI_SPECIALIST_MODEL` | Carousel / stuck recovery. Default `claude-sonnet-4-6`. |
| `KOWALSKI_VISION_MODEL` | In-loop vision calls. Default `claude-sonnet-4-6`. |
| `KOWALSKI_EXTRACTION_MODEL` | Per-capture structured extraction. Default `claude-sonnet-4-6`. |
| `KOWALSKI_TAGGING_MODEL` | Per-image tagging. Default `claude-sonnet-4-6`. |
| `KOWALSKI_DIGEST_MODEL` | Text-only digest synthesis. Default `claude-haiku-4-5`. |
| `KOWALSKI_ANALYSIS_MODEL` | Analysis / insights pass. Default `claude-sonnet-4-6`. |

Model defaults live in [src/shared/modelConfig.ts](src/shared/modelConfig.ts).

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
│                                   # (paths, api key, runConfig, events, abort signal)
├── plugin/                         # OpenClaw plugin surface
│   ├── index.ts                    # register(api) — the 8 tools
│   ├── cookie-probe.ts             # Read Instagram sessionid out of Chromium cookies DB
│   └── session-registry.ts         # Per-session event buffer for get_session_status
├── main/
│   ├── main.ts                     # Legacy Electron entry, gutted (breadcrumb only)
│   ├── prompts/                    # Markdown prompts shipped to the agents
│   │   ├── capabilities.md
│   │   ├── navigator-agent.md
│   │   ├── stories-instructions.md
│   │   ├── feed-instructions.md
│   │   ├── login-instructions.md   # Stage 6 — scene list + login actions
│   │   └── examples/               # Reference screenshots per phase
│   └── services/
│       ├── BaseVisionAgent.ts      # Abstract observe→label→Claude→act loop
│       ├── LoginAgent.ts           # Stage 6 — agentic IG login
│       ├── StoriesAgent.ts         # Phase 1 — stories viewer
│       ├── FeedAgent.ts            # Phase 2 — feed + post modals + carousels
│       ├── Extractor.ts            # Phase 2.5 — per-image structured extraction
│       ├── DigestGeneration.ts     # Phase 3 — text-only editorial
│       ├── AnalysisGenerator.ts    # Insights pass over a digest
│       ├── ContentVision.ts        # Shared Claude vision-call helpers
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
│   ├── modelConfig.ts              # Centralised + env-overridable model IDs
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

Default model choices are centralised in [src/shared/modelConfig.ts](src/shared/modelConfig.ts):

- **Sonnet 4.6** for every vision-and-reasoning call (navigation, extraction, analysis, login).
- **Haiku 4.5** for the text-only digest synthesis (all visual work is done upstream, so the writer runs cheap).

Typical cost + duration expectations, per [SKILL.md](skills/instagram-digest/SKILL.md):

- **Typical full run:** 10–30 minutes, $1–3 in Anthropic spend.
- **Hard caps:** stories phase 15 min, feed phase 30 min.
- **Worst case:** ~45 min total, ~$3.

Every model is env-overridable so you can drop Sonnet to Haiku where accuracy allows — see the env-var table above.

---

## Development

```bash
npm install
npx tsc --noEmit        # Typecheck

npm run test:plugin     # Plugin surface — asserts 8 tools registered in order
npm run test:login      # LoginAgent against a local fake-IG fixture
                        # (scripted callLLM — no Anthropic calls)
npm run test:extract    # Extractor agent against an existing raw/ dir
npm run test:digest     # Digest generation against a set of sidecars
npm run test:run        # Full pipeline against a real IG session
                        # (requires logged-in profile + API key + real Anthropic cost)
```

The plugin loads TypeScript directly — the OpenClaw loader consumes `src/plugin/index.ts` with no build step and no `dist/` output. Edits to any file in this tree are picked up on the next `openclaw gateway run` boot (provided the plugin was installed with `--link`).

---

## Disclaimer

Instagram's terms of service prohibit automated access, and Instagram actively works to prevent AI agents and bots from using the platform. Running Kowalski may result in rate limiting, challenges, temporary restrictions, or permanent suspension of your Instagram account.

**Use of Kowalski is entirely at your own risk.** I am not responsible for any consequences that arise from running this software, including but not limited to account bans, data loss, API costs, or any other issues. This is an experimental personal project provided as-is, with no warranty of any kind.
