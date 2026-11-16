// @ts-check
import { createQueryClient } from "./core.js";

/**
 * Helpers for the query tests: a fake clock and timers, deferred promises,
 * and fetchers whose calls the test resolves by hand.
 */

export function fakeTime() {
  let now = 0;
  let nextHandle = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  return {
    now: () => now,
    /** @param {() => void} fn @param {number} ms */
    setTimer(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    /** @param {number} handle */
    clearTimer: (handle) => void timers.delete(handle),
    /** Moves the clock forward, running timers that come due. @param {number} ms */
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.fn();
      }
    },
    get timerCount() {
      return timers.size;
    },
  };
}

/** @param {Partial<import("./core.js").QueryClientOptions>} [options] */
export function testClient(options = {}) {
  const time = fakeTime();
  /** @type {unknown[]} */
  const reported = [];
  const client = createQueryClient({
    gcTime: 1000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    reportError: (error) => reported.push(error),
    ...options,
  });
  return { client, time, reported };
}

/** @template [T=unknown] */
export function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(error: unknown) => void} */
  let reject = () => {};
  /** @type {Promise<T>} */
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fetcher whose calls stay pending until the test settles them.
 * @template [T=unknown]
 */
export function manualFetcher() {
  /** @type {{ key: readonly unknown[], signal: AbortSignal, resolve: (value: T) => void, reject: (error: unknown) => void }[]} */
  const calls = [];
  /** @param {{ key: readonly unknown[], signal: AbortSignal }} context */
  const fetcher = (context) => {
    const { promise, resolve, reject } = deferred();
    calls.push({ ...context, resolve, reject });
    return /** @type {Promise<T>} */ (promise);
  };
  return { fetcher, calls };
}

/** Lets pending promise callbacks run. */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
