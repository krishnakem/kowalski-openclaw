# Kowalski — OpenClaw plugin

**I have an Instagram addiction, so I built an agent that scrolls it for me and hands back a digest.** Ask your OpenClaw agent *"what's happening on my feed today?"* and Kowalski drives a real Chromium browser through your stories and feed with vision-agent loops, then writes you a readable markdown summary — so you stay in the loop without the doomscroll.

The heavy lifting is all local: real Playwright-controlled Chromium against your real session cookie, a vision agent at every browsing step (login, stories, feed), structured extraction per capture, and a deterministic text-only digest writer over those extractions. No scraping, no undocumented APIs — just a browser driven by a model.

> **Status — OpenClaw-native.** Kowalski is a pure OpenClaw plugin: Playwright automation plus model calls routed through `api.runtime`, wired to an OpenClaw `register(api)` entrypoint. See [REFACTOR_NOTES.md](REFACTOR_NOTES.md) for the full refactor history, architectural trade-offs, and known risks.

---

## Why it's built this way

The interesting engineering problem isn't "read Instagram" — it's driving a hostile, anti-automation web app reliably enough that an agent can do it unattended. That means:

- **Vision at the browsing layer, text at the synthesis layer.** Expensive vision-model calls happen only during capture; the digest itself runs on a cheap text model over already-extracted structured data. Cost stays low without losing fidelity.
- **A time budget, not a task list.** Runs are bounded by a user-requested duration (30% stories / 70% feed), so the agent degrades gracefully into a partial digest instead of running forever.
- **Human-like operation.** Stealth-patched Chromium, ghost-mouse movement, and human-cadence scrolling so the activity blends into normal browsing.

## What the plugin exposes

Kowalski registers **eleven tools** on the OpenClaw agent surface; the [skills](skills/) playbooks tell the agent how to run digests, adjust timers, and answer remaining-time questions.

| Tool | Purpose |
| --- | --- |
| `start_session` | Create a session for the requested duration and auto-continue: valid cookie → digest starts in the background; missing/unknown cookie → headless login flow, returning any pending state that needs user input. |
| `login` | Continue the headless login flow. Returns `pending_credentials` / `pending_2fa` / `pending_device_approval` as needed; on success, starts the digest in the background. |
| `submit_verification_code` | Second leg of login. Accepts a 2FA code, or polls for device approval when `code: null`; on success starts the digest. |
| `update_timer` | Change a session's duration. Recomputes the stories/feed split before capture; mid-run, extra time goes to feed and the run finalizes a partial digest if the new timer is already met. |
| `run_digest` | Manually run capture → extraction → digest → PDF and return display-ready markdown. (Normally started for you.) Bounded by duration: 30% stories, 70% feed. |
| `get_session_status` | Latest run phase + last ~20 pipeline events. |
| `print_digest` | Poll for the completed digest; returns display-ready markdown (emoji preserved) and auto-ends the session after printing. |
| `reset_memory` | Delete the cross-run session-memory JSON for a clean slate. |
| `reset_all` | Dry-run-first factory reset of browser profile, scratch, and output. Requires `confirm: true`. |
| `stop_run` | Global stop switch; finalizes a partial digest/PDF tagged `abortReason: user-stop` when captures exist. |
| `end_session` | Abort the in-flight run, close the Playwright context, drop the session. |

Happy path: `start_session → get_session_status / print_digest`. Login pending-states tell the agent exactly which input (credentials, 2FA, device approval) is needed before the workflow resumes.

## Pipeline

```text
Navigator (vision agent)      stories + feed → JPEG frames + sidecar JSON
   ↓
Extractor (vision, per frame) structured content (handle, caption, entities, usefulness)
   ↓
Digest writer (text only)     single markdown editorial + PDF export
```

Stages communicate through the filesystem, so a slow or stuck stage never blocks the others.

## Installation

Install as a linked OpenClaw plugin and configure your browser profile, scratch, and output directories (see `openclaw.plugin.json` for the full config schema — `browserProfileDir`, `scratchDir`, `outputDir`, plus optional `userName` / `location` context the agent uses to personalize the digest).

## Related

Kowalski is one of several agents built on my OpenClaw harness. It started life as a standalone Electron app ([krishnakem/kowalski](https://github.com/krishnakem/kowalski)) and was refactored into this native plugin; the reusable lifecycle underneath comes from [Agent-Template](https://github.com/krishnakem/Agent-Template).

## Disclaimer

For personal use against your own account. Respect Instagram's terms and rate limits.
