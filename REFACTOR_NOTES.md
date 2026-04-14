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
