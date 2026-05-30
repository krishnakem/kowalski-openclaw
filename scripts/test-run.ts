/**
 * Full pipeline harness.
 *
 * Direct provider fallback has been removed. A real run now requires the
 * OpenClaw plugin runtime because all model calls go through api.runtime.
 */

console.log(
    'Skipped: standalone full-run testing requires direct provider access, which has been removed. Run the pipeline through the OpenClaw plugin runtime instead.'
);
