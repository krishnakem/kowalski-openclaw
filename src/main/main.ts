/**
 * Legacy Electron entrypoint — gutted during Stage 1 of the OpenClaw refactor.
 *
 * The original file wired up BrowserWindow creation, a kowalski-local://
 * custom protocol, global shortcuts, electron-store-backed settings, and
 * ~30 ipcMain handlers that fronted the services under src/main/services/.
 *
 * All of that is removed. What remains is a map of where service
 * orchestration used to happen, so the next stage knows where the OpenClaw
 * plugin surface needs to call in. See REFACTOR_NOTES.md for the full audit.
 *
 * This file will NOT compile or run on its own anymore — that is expected.
 * It exists only as a breadcrumb for the upcoming plugin wiring.
 */

// TODO (OpenClaw plugin): replace the following orchestration points.
//
// 1. Run lifecycle
//    - RunManager.getInstance().startRun({ phases?: ['stories' | 'feed'] })
//    - RunManager.getInstance().stopRun()
//    - RunManager.getInstance().skipToFeed()
//    - RunManager.getInstance().getStatus()
//    - RunManager.getInstance().notifyOffline()
//    Today these were bound to ipcMain.handle('run:*') and global shortcuts
//    (Cmd+Shift+H/K/S/F). The plugin will invoke them directly from tool
//    handlers; there is no window to notify, so the event-emitter surface on
//    RunManager needs to be the public progress channel.
//
// 2. Browser / login surface
//    - BrowserManager.getInstance().startLoginScreencast() / stopLoginScreencast()
//    - BrowserManager.getInstance().dispatchInput(payload)
//    - BrowserManager.getInstance().clearData()
//    - BrowserManager.getInstance().getContext()
//    Screencast + input forwarding was the renderer-side interactive login.
//    The OpenClaw plugin either (a) headfully launches and lets the user
//    log in directly, or (b) drops screencast entirely. To be decided in a
//    later stage.
//
// 3. Secure key storage
//    - SecureKeyManager.getInstance().setKey / getKey / getKeyStatus
//    Backed by Electron safeStorage today. Needs to become a pluggable
//    KeyProvider the OpenClaw host supplies (env var, OS keychain, etc.).
//
// 4. Usage accounting
//    - UsageService.getInstance().initialize()
//    Called once at app boot. Move to explicit session init.
//
// 5. Session memory reset
//    - new SessionMemory().resetMemory()
//    Was bound to Cmd+Shift+R. Becomes a plugin tool.
//
// 6. Persistent data paths
//    The Electron build used app.getPath('userData') for:
//      - analysis_records/{recordId}/images/{filename}  (served via
//        kowalski-local:// to the renderer)
//      - analysis_records/{id}.json                     (per-run digest)
//      - session.json                                   (legacy)
//      - kowalski_browser/                              (Playwright profile)
//    These need to come from a caller-supplied scratch/data dir — see the
//    KowalskiSession sketch at the bottom of REFACTOR_NOTES.md.
//
// 7. Instagram session status probe
//    Reads kowalski_browser/Default/Cookies directly with better-sqlite3 to
//    check for an unexpired sessionid on instagram.com. This logic is
//    self-contained and portable — it just needs the profile path passed in.
//
// 8. Clipboard + paste bridging
//    ipcMain listened for 'kowalski:paste' and 'kowalski:copySelection' to
//    bridge the host OS clipboard to the guest Playwright page. No analogue
//    in a headless plugin — drop unless OpenClaw exposes a clipboard tool.
//
// 9. API-key validation
//    The 'settings:validate-api-key' handler did a 1-token ping to
//    api.anthropic.com. Keep the logic; move to a plain async function so the
//    plugin can expose it as a tool.
