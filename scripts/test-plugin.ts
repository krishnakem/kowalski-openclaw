/**
 * Fake-register smoke test for the OpenClaw plugin surface.
 *
 * Does NOT start a browser, hit Anthropic, or touch any real Instagram
 * profile. What it proves:
 *
 *   1. The plugin module imports and exposes a `register(api)` function
 *      on both the named export and the default export.
 *   2. `register` accepts a minimal PluginApi with pluginConfig + a mock
 *      registerTool collector, and does not throw.
 *   3. All six expected tools are registered in the expected order, with
 *      the expected `optional` flag on `login`.
 *   4. Each tool's `parameters` schema is a well-formed JSON-Schema-ish
 *      object (type: 'object', properties object present).
 *   5. Invoking `start_session.execute()` returns a result matching the
 *      OpenClaw-tool contract: { content: [{ type: 'text', text }] }.
 *
 * Run: `npm run test:plugin`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import pluginDefault, {
    register,
    type PluginApi,
    type PluginTool,
} from '../src/plugin/index.js';

function fail(msg: string): never {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) fail(msg);
}

function main(): void {
    // Sandbox paths under tmpdir so the test never touches ~/.kowalski.
    const tmpRoot = path.join(os.tmpdir(), `kowalski-plugin-smoke-${uuidv4()}`);
    const pluginConfig = {
        anthropicApiKey: 'sk-ant-smoketest-not-a-real-key',
        browserProfileDir: path.join(tmpRoot, 'browser'),
        scratchDir: path.join(tmpRoot, 'scratch'),
        outputDir: path.join(tmpRoot, 'output'),
        userName: 'Smoke Tester',
        location: 'Localhost',
    };

    // Mock api — a collector + a minimal logger.
    const registered: Array<{ tool: PluginTool; opts: { optional?: boolean } | undefined }> = [];
    const mockApi: PluginApi = {
        pluginConfig,
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
        },
        registerTool: (tool, opts) => {
            registered.push({ tool, opts });
        },
    };

    // (1) Module shape.
    assert(typeof register === 'function', 'named export `register` is not a function');
    assert(
        pluginDefault && typeof pluginDefault.register === 'function',
        'default export does not expose `register`'
    );
    assert(pluginDefault.id === 'kowalski-openclaw', `default.id mismatch: ${pluginDefault.id}`);
    assert(pluginDefault.name === 'Kowalski', `default.name mismatch: ${pluginDefault.name}`);
    console.log('✅ plugin module shape is valid');

    // (2) register() runs without throwing.
    let teardown: (() => void) | undefined;
    try {
        teardown = register(mockApi);
    } catch (err) {
        fail(`register() threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('✅ register(api) completed');

    // (3) All six tools got registered, in order, with the right `optional` flag.
    const expected = [
        { name: 'start_session', optional: undefined },
        { name: 'login', optional: undefined },
        { name: 'run_digest', optional: undefined },
        { name: 'get_session_status', optional: undefined },
        { name: 'reset_memory', optional: undefined },
        { name: 'end_session', optional: undefined },
    ];
    assert(
        registered.length === expected.length,
        `expected ${expected.length} tools, got ${registered.length}`
    );
    for (let i = 0; i < expected.length; i++) {
        const got = registered[i];
        const want = expected[i];
        assert(
            got.tool.name === want.name,
            `tool[${i}] name mismatch: expected ${want.name}, got ${got.tool.name}`
        );
        const gotOptional = got.opts?.optional;
        assert(
            gotOptional === want.optional,
            `tool[${i}] optional flag mismatch: expected ${String(want.optional)}, got ${String(gotOptional)}`
        );
    }
    console.log(`✅ registered ${registered.length} tools in the expected order`);

    // (4) Each tool has a well-formed parameters schema + a description + execute().
    for (const { tool } of registered) {
        assert(typeof tool.description === 'string' && tool.description.length > 0,
            `tool ${tool.name} missing description`);
        assert(typeof tool.execute === 'function', `tool ${tool.name} missing execute()`);
        assert(tool.parameters && tool.parameters.type === 'object',
            `tool ${tool.name} parameters.type must be "object"`);
        assert(
            tool.parameters.properties && typeof tool.parameters.properties === 'object',
            `tool ${tool.name} parameters.properties must be an object`
        );
    }
    console.log('✅ every tool has description + execute + JSON-Schema-ish parameters');

    // (5) Invoke start_session and check the return shape.
    const startSession = registered.find((r) => r.tool.name === 'start_session');
    assert(startSession, 'start_session not registered');
    const result = startSession.tool.execute('smoke-call-1', { phases: ['stories'] });
    assert(result instanceof Promise, 'start_session.execute must return a Promise');

    result
        .then((r) => {
            assert(r && Array.isArray(r.content), 'execute result must have content[]');
            assert(r.content.length > 0, 'execute result content[] is empty');
            const first = r.content[0];
            assert(first.type === 'text' && typeof first.text === 'string',
                'execute result content[0] must be { type: "text", text }');
            const parsed = JSON.parse(first.text);
            assert(typeof parsed.session_id === 'string' && parsed.session_id.length > 0,
                'start_session result missing session_id');
            assert('logged_in' in parsed, 'start_session result missing logged_in');
            assert(typeof parsed.message === 'string', 'start_session result missing message');
            console.log('✅ start_session returns { content:[{type:"text",text:<json>}] }');

            // Teardown — and also clean up the tmp dirs so repeat runs stay clean.
            teardown?.();
            try {
                fs.rmSync(tmpRoot, { recursive: true, force: true });
            } catch {
                /* ignore cleanup failures */
            }

            console.log('\n🎉 plugin smoke test passed');
            process.exit(0);
        })
        .catch((err) => {
            fail(`start_session.execute threw: ${err instanceof Error ? err.message : String(err)}`);
        });
}

main();
