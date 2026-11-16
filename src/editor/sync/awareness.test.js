// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { Awareness, HEARTBEAT, THROTTLE, TIMEOUT } from "./awareness.js";
import { decodeMessage } from "./protocol.js";

/** A fake clock with timers, so throttling, heartbeats and expiry run instantly. */
function fakeTime() {
  let now = 1000;
  /** @type {{ at: number, fn: () => void, every: number, id: number }[]} */
  let timers = [];
  let ids = 0;
  const add = (
    /** @type {() => void} */ fn,
    /** @type {number} */ ms,
    /** @type {number} */ every,
  ) => {
    const id = ++ids;
    timers.push({ at: now + ms, fn, every, id });
    return /** @type {any} */ (id);
  };
  const clear = (/** @type {any} */ id) => {
    timers = timers.filter((t) => t.id !== id);
  };
  return {
    now: () => now,
    setTimer: /** @type {typeof setTimeout} */ (
      /** @type {unknown} */ ((fn, ms) => add(fn, ms ?? 0, 0))
    ),
    clearTimer: /** @type {typeof clearTimeout} */ (clear),
    setRepeat: /** @type {typeof setInterval} */ (
      /** @type {unknown} */ ((fn, ms) => add(fn, ms ?? 0, ms ?? 0))
    ),
    clearRepeat: /** @type {typeof clearInterval} */ (clear),
    /** @param {number} ms */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every > 0) due.at += due.every;
        else clear(due.id);
        due.fn();
      }
      now = until;
    },
  };
}

/** @param {Uint8Array[]} sent */
const states = (sent) =>
  sent.map((bytes) => {
    const msg = decodeMessage(bytes);
    assert.equal(msg.type, "awareness");
    if (msg.type !== "awareness") throw new Error();
    assert.equal(msg.entries.length, 1);
    return {
      clock: msg.entries[0].clock,
      state: msg.entries[0].state === "" ? null : JSON.parse(msg.entries[0].state),
    };
  });

test("the local state goes out on connect, at most every 50 ms, and repeats are skipped", () => {
  const time = fakeTime();
  const a = new Awareness(7, time);
  /** @type {Uint8Array[]} */
  const sent = [];
  a.setLocal({ n: 0 });
  assert.equal(sent.length, 0, "nothing goes out before connecting");
  a.connect((bytes) => sent.push(bytes));
  assert.deepEqual(states(sent), [{ clock: 1, state: { n: 0 } }]);

  a.setLocal({ n: 1 });
  a.setLocal({ n: 2 });
  a.setLocal({ n: 3 });
  assert.equal(sent.length, 1, "throttled");
  time.advance(THROTTLE);
  assert.deepEqual(
    states(sent).slice(1),
    [{ clock: 2, state: { n: 3 } }],
    "the last state of the window goes out",
  );

  time.advance(THROTTLE * 2);
  a.setLocal({ n: 3 });
  time.advance(THROTTLE);
  assert.equal(sent.length, 2, "an unchanged state isn't sent again");
  a.setLocal({ n: 4 });
  assert.equal(sent.length, 3, "after a quiet window, a change goes out at once");
  a.destroy();
});

test("the state is repeated every 15 s, with a new clock", () => {
  const time = fakeTime();
  const a = new Awareness(7, time);
  /** @type {Uint8Array[]} */
  const sent = [];
  a.setLocal({ here: true });
  a.connect((bytes) => sent.push(bytes));
  time.advance(HEARTBEAT * 2);
  assert.deepEqual(
    states(sent).map((s) => s.clock),
    [1, 2, 3],
  );
  a.destroy();
});

test("remote states: newer clocks win, our own session and junk are ignored, and they expire", () => {
  const time = fakeTime();
  const a = new Awareness(7, time);
  /** @type {import("./awareness.js").AwarenessChange[]} */
  const changes = [];
  a.observe((c) => changes.push(c));
  a.connect(() => {});
  a.receive([
    { session: 1, clock: 2, user: "u1", state: '{"x":1}' },
    { session: 7, clock: 9, user: "me", state: '{"self":true}' },
    { session: 3, clock: 1, user: "u3", state: "{not json" },
  ]);
  assert.deepEqual([...a.peers.keys()], [1]);
  assert.deepEqual(a.peers.get(1)?.state, { x: 1 });
  assert.equal(a.peers.get(1)?.user, "u1");
  assert.deepEqual(changes, [{ added: [1], updated: [], removed: [] }]);

  a.receive([{ session: 1, clock: 2, user: "u1", state: '{"x":"stale"}' }]);
  a.receive([{ session: 1, clock: 1, user: "u1", state: '{"x":"older"}' }]);
  assert.deepEqual(a.peers.get(1)?.state, { x: 1 });
  assert.equal(changes.length, 1, "no change event for ignored states");
  a.receive([{ session: 1, clock: 3, user: "u1", state: '{"x":2}' }]);
  assert.deepEqual(a.peers.get(1)?.state, { x: 2 });
  assert.deepEqual(changes.at(-1), { added: [], updated: [1], removed: [] });

  // Someone who stops sending is dropped after 30 s; someone who keeps sending isn't.
  a.receive([{ session: 2, clock: 1, user: "u2", state: "{}" }]);
  // (Expiry is checked every 5 s, so it happens 30–35 s after the last message.)
  time.advance(TIMEOUT - 6000);
  a.receive([{ session: 2, clock: 2, user: "u2", state: "{}" }]);
  time.advance(15_000);
  assert.deepEqual([...a.peers.keys()], [2]);
  assert.deepEqual(changes.at(-1), { added: [], updated: [], removed: [1] });

  // An explicit leave.
  a.receive([{ session: 2, clock: 3, user: "u2", state: "" }]);
  assert.equal(a.peers.size, 0);
  a.destroy();
});

test("disconnecting forgets everyone and stops sending; the clock keeps counting", () => {
  const time = fakeTime();
  const a = new Awareness(7, time);
  /** @type {Uint8Array[]} */
  const sent = [];
  a.setLocal({ v: 1 });
  a.connect((bytes) => sent.push(bytes));
  a.receive([{ session: 1, clock: 1, user: "u1", state: "{}" }]);
  a.disconnect();
  assert.equal(a.peers.size, 0);
  assert.equal(a.connected, false);
  a.setLocal({ v: 2 });
  time.advance(HEARTBEAT * 3);
  assert.equal(sent.length, 1, "nothing goes out while disconnected");
  a.connect((bytes) => sent.push(bytes));
  assert.deepEqual(
    states(sent).at(-1),
    { clock: 2, state: { v: 2 } },
    "after a reconnect the state goes out again, with a newer clock",
  );
  a.destroy();
});
