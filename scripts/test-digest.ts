/**
 * Digest prompt harness.
 *
 * Direct provider fallback has been removed. Real digest generation now
 * requires the OpenClaw plugin runtime because text completion is provided by
 * api.runtime.llm.complete.
 */

console.log(
    'Skipped: standalone digest testing requires direct provider access, which has been removed. Run digest generation through the OpenClaw plugin runtime instead.'
);
