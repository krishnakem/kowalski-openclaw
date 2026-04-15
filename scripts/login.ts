/**
 * One-shot headful Instagram login (CLI wrapper).
 *
 * The implementation now lives in src/plugin/login-flow.ts so the
 * OpenClaw plugin's `login` tool and this CLI share exactly one
 * codepath. This file is a thin entrypoint kept for `npm run login`
 * and for any pre-plugin smoke-testing.
 *
 * Usage:
 *   npm run login
 *   KOWALSKI_PROFILE_DIR=/custom/path npm run login
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLogin } from '../src/plugin/login-flow.js';

export { runLogin };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisModulePath = fileURLToPath(import.meta.url);
if (invokedPath === thisModulePath) {
    const profileDir =
        process.env.KOWALSKI_PROFILE_DIR ?? path.join(os.homedir(), '.kowalski', 'browser');
    runLogin(profileDir)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('❌ Login failed:', err);
            process.exit(1);
        });
}
