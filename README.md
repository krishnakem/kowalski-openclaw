# Kowalski

An AI-powered desktop app that automatically browses your Instagram stories and feed, then composes a curated daily digest — so you stay in the loop without the endless scroll.

Kowalski runs a real Chromium browser via Playwright, drives it with Claude vision agents that "see" the page through screenshots and act with human-like mouse and scroll, and then synthesises everything it captured into a single readable editorial.

## How It Works

Kowalski is built around a three-agent pipeline. Each agent has a single job and they communicate through the filesystem rather than in-memory state, so a stuck or slow stage never blocks the others.

1. **Navigator (Phase 1 + 2)** — A vision agent operates the browser. It runs in two phases:
   - **Stories phase** ([StoriesAgent](src/main/services/StoriesAgent.ts)) — clicks through your unwatched stories and exits when the advance arrow disappears.
   - **Feed phase** ([FeedAgent](src/main/services/FeedAgent.ts)) — scrolls the feed, opens posts and carousels, dismisses popups, and captures content until the time budget is spent.
   Every meaningful frame is dumped as a JPEG into a `raw/` directory with a sidecar JSON describing what the agent thought it was looking at.

2. **Extractor (Phase 2.5)** — [Extractor.ts](src/main/services/Extractor.ts) watches `raw/` and, for each new screenshot, calls a vision model **once** to pull out structured content (handle, caption, entities, narrative, usefulness score). The result is merged into the same sidecar JSON. Loading screens, ads, and duplicates are tagged `usefulness: "skip"` rather than deleted, so nothing is lost and you can audit what was culled.

3. **Digest writer (Phase 3)** — [DigestGeneration.ts](src/main/services/DigestGeneration.ts) consumes the sidecars as **text only** and composes a single markdown editorial column. Because all visual extraction happened upstream, this stage runs on a cheaper text model (Haiku by default).

The whole run is time-bounded (configurable, default 90 minutes max), and the agents use [GhostMouse](src/main/services/GhostMouse.ts) and [HumanScroll](src/main/services/HumanScroll.ts) plus a stealth-patched Chromium so the activity blends into normal browsing.

## Gets Better The More You Run It

Kowalski keeps a lightweight memory of past sessions via [SessionMemory](src/main/services/SessionMemory.ts), stored at `{userData}/session_memory/summaries.json`. Each completed run adds a compact summary — which accounts produced the most useful captures, which phases were productive, where the agent stalled or recovered — and the most recent summaries are folded into the navigator's context on the next run.

The practical effect:

- **Sharper capture decisions.** The agent learns which accounts tend to post signal vs. noise on your feed and spends more attention where it pays off.
- **Fewer dead ends.** Patterns of getting stuck (particular popup types, layouts, carousel edge cases) surface as hints in subsequent runs, so recovery is faster.
- **Tuned to your feed.** Because the memory is local to your machine, the agent specialises to *your* Instagram — the accounts you follow, the kinds of posts you care about, the rhythm of your usage.

Memory is capped at the last 20 sessions and costs nothing to maintain (it's pure file I/O, no LLM calls). You can reset it any time with **Cmd+Shift+R** or the Reset button in Settings.

## Tech Stack

- **Desktop shell** — Electron 39 with a custom main-process build pipeline ([scripts/build-electron.mjs](scripts/build-electron.mjs))
- **Browser automation** — Playwright + `playwright-extra` + `puppeteer-extra-plugin-stealth`
- **Frontend** — React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Radix primitives, Framer Motion
- **AI** — Claude API (Anthropic) — Sonnet 4.6 for navigation and vision, Haiku 4.5 for text-only digest synthesis
- **Storage** — JSON records on disk for the digest archive, `electron-store` for settings and indexing, `safeStorage`-encrypted API key via [SecureKeyManager](src/main/services/SecureKeyManager.ts) (encryption key held in macOS Keychain)
- **Live preview** — CDP screencast piped to a [LiveScreencast](src/components/LiveScreencast.tsx) React component so you can watch the agent work

## Download

The latest release is available on GitHub:

**[Download Kowalski v0.1.0 →](https://github.com/krishnakem/kowalski/releases/latest)**

Grab the `Kowalski-0.1.0-arm64.dmg` asset from the release page.

**Requirements:** macOS on Apple Silicon (M1 / M2 / M3 / M4). Intel Macs are not supported.

### Disclaimer

Instagram's terms of service prohibit automated access, and Instagram actively works to prevent AI agents and bots from using the platform. Running Kowalski may result in rate limiting, challenges, temporary restrictions, or permanent suspension of your Instagram account.

**Use of Kowalski is entirely at your own risk.** I am not responsible for any consequences that arise from running this software, including but not limited to account bans, data loss, API costs, or any other issues. This is an experimental personal project provided as-is, with no warranty of any kind.

### Install

1. Open the downloaded `.dmg` and drag **Kowalski** into your `Applications` folder.
2. On first launch, right-click `Kowalski.app` → **Open** → **Open**. This bypasses Gatekeeper for the unsigned build — you only need to do it once.


The app is self-contained — its own Chromium ships inside the bundle, so there's nothing else to install.

## Configuration

Set your Anthropic API key in the app's **Settings** page — it's `safeStorage`-encrypted via [SecureKeyManager](src/main/services/SecureKeyManager.ts) before being written to disk, with the encryption key held in macOS Keychain.

Models are centralised in [src/shared/modelConfig.ts](src/shared/modelConfig.ts) and every one is overridable via environment variable:

| Variable | Stage | Default |
|---|---|---|
| `KOWALSKI_STORIES_MODEL` | Stories navigation | `claude-sonnet-4-6` |
| `KOWALSKI_NAV_MODEL` | Feed navigation | `claude-sonnet-4-6` |
| `KOWALSKI_SPECIALIST_MODEL` | Carousels / stuck recovery | `claude-sonnet-4-6` |
| `KOWALSKI_VISION_MODEL` | In-loop vision calls | `claude-sonnet-4-6` |
| `KOWALSKI_TAGGING_MODEL` | Per-image tagging | `claude-sonnet-4-6` |
| `KOWALSKI_EXTRACTION_MODEL` | Extractor (per-image structured extraction) | `claude-sonnet-4-6` |
| `KOWALSKI_DIGEST_MODEL` | Text-only digest synthesis | `claude-haiku-4-5` |
| `KOWALSKI_ANALYSIS_MODEL` | Insights / analysis generation | `claude-sonnet-4-6` |

## Project Structure

```
src/
├── main/                          # Electron main process
│   ├── main.ts                    # Entry point, window + IPC handlers, custom protocol
│   ├── prompts/                   # Markdown prompts shipped to the agents
│   │   ├── navigator-agent.md
│   │   ├── stories-instructions.md
│   │   ├── feed-instructions.md
│   │   ├── capabilities.md
│   │   └── examples/              # Few-shot screenshots + action traces
│   └── services/
│       ├── Kowalski.ts            # Phase orchestrator (stories → feed)
│       ├── RunManager.ts          # Run lifecycle: start, stop, offline handling
│       ├── BrowserManager.ts      # Playwright lifecycle + CDP screencast
│       ├── BaseVisionAgent.ts     # Abstract screenshot → Claude → act loop
│       ├── StoriesAgent.ts        # Phase 1 — stories navigation
│       ├── FeedAgent.ts           # Phase 2 — feed navigation
│       ├── Extractor.ts           # Phase 2.5 — async per-image structured extraction
│       ├── DigestGeneration.ts    # Phase 3 — text-only editorial synthesis
│       ├── AnalysisGenerator.ts   # Insights pass over the digest
│       ├── ContentVision.ts       # Shared Claude vision call helpers
│       ├── ImageTagger.ts         # Per-image tagging utilities
│       ├── ScreenshotCollector.ts # raw/ + sidecar writer, session log
│       ├── SessionMemory.ts       # Cross-session memory digest
│       ├── NetworkMonitor.ts      # Offline watchdog + error classification
│       ├── GhostMouse.ts          # Human-like mouse paths (Bezier + jitter)
│       ├── HumanScroll.ts         # Human-like scroll dynamics
│       ├── Scroller.ts            # Lower-level scroll primitives
│       ├── InputForwarder.ts      # Renderer → page keystroke/paste bridge
│       ├── SecureKeyManager.ts    # safeStorage-encrypted API key store
│       ├── UsageService.ts        # Token + cost accounting
│       └── ChromiumVersionHelper.ts
├── components/
│   ├── screens/                   # ZeroState, AgentActive, AnalysisReady, Gazette, Login, DigestFailed
│   ├── gazette/                   # Digest rendering (DigestView, SectionCard, ContentItem)
│   ├── LiveScreencast.tsx         # Live CDP screencast viewer
│   ├── modals/, layouts/, ui/, icons/
│   └── ErrorBoundary.tsx
├── pages/                         # Top-level routes (Index, Settings, AnalysisArchive, NotFound)
├── shared/
│   ├── modelConfig.ts             # Centralised LLM model config
│   └── viewportConfig.ts          # Shared viewport dimensions
└── types/                         # TypeScript type definitions (analysis, instagram, navigation, session-memory)
scripts/                           # Build pipeline: Chromium staging, icon generation, test runners
```

## Stopping a Run

Use **Cmd/Ctrl + Shift + K** (or the Stop button in the active-run screen). Stop is cooperative: the screencast tears down immediately, the active agent sees the stop flag between LLM calls, and the browser closes cleanly without spinning on errors.

## Where Things Live on Disk

Everything lives under `~/Library/Application Support/Kowalski/`:

- **Captured screenshots + sidecars** — `kowalski-runs/<timestamp>/raw/{stories,feed}/` — one JPEG plus a JSON sidecar per meaningful frame
- **Generated digests** — `analysis_records/` as JSON, indexed via `electron-store` and surfaced through the **Archive** page
- **Cross-session memory** — `session_memory/summaries.json` — compact per-run summaries that condition the next run
- **Settings** — `electron-store` JSON
- **API key** — `safeStorage`-encrypted in `electron-store`; the encryption key itself is held in macOS Keychain
- **Browser profile** — dedicated Chromium user-data dir so the Instagram session persists between runs
