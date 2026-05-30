/**
 * Extractor prompt harness.
 *
 * Direct provider fallback has been removed. Real extraction now requires the
 * OpenClaw plugin runtime because image understanding is provided by
 * api.runtime.mediaUnderstanding.
 */

console.log(
    'Skipped: standalone extraction testing requires direct provider access, which has been removed. Run extraction through the OpenClaw plugin runtime instead.'
);
