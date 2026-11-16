// @ts-check
import { test } from "node:test";
import { runFuzz } from "./fuzz-harness.js";

/**
 * Convergence fuzzing (the harness is in fuzz-harness.js). Every run must
 * end with all replicas holding identical state: same materialized JSON,
 * same state vector, byte-identical snapshots, and a fresh replica loading
 * the snapshot agrees.
 *
 * Reproduce a failure with FUZZ_SEED=<seed> (and FUZZ_OPS=<n>):
 *   FUZZ_SEED=123 node --test src/editor/model/fuzz.test.js
 */

/** @type {Record<string, string | undefined>} */
const env = /** @type {any} */ (globalThis).process?.env ?? {};
const OPS = Number(env.FUZZ_OPS ?? 10_000);
const SEEDS = env.FUZZ_SEED ? [Number(env.FUZZ_SEED)] : [1, 2, 3, 42, 1053, 1337]; // 1053: undo restoring half a surrogate pair (fixed)

for (const seed of SEEDS) {
  test(`fuzz: replicas converge (seed ${seed}, ${OPS} ops)`, () => {
    const t0 = performance.now();
    let result;
    try {
      result = runFuzz(seed, OPS);
    } catch (err) {
      console.error(
        `\nFUZZ FAILURE — reproduce with: FUZZ_SEED=${seed} FUZZ_OPS=${OPS} node --test src/editor/model/fuzz.test.js\n`,
      );
      throw err;
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`fuzz seed=${seed}: ${JSON.stringify(result)} in ${ms} ms`);
  });
}
