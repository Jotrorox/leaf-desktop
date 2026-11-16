// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, flush, manualFetcher, testClient } from "./testing.js";

test("fetch runs the fetcher and stores the result", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  /** @type {import("./core.js").QueryState[]} */
  const states = [];
  client.observe(["page", "p1"], (state) => states.push(state));

  const result = client.fetch(["page", "p1"], fetcher);
  assert.equal(client.getState(["page", "p1"]).fetching, true);
  assert.equal(client.getState(["page", "p1"]).status, "pending");
  calls[0].resolve({ id: "p1" });

  assert.deepEqual(await result, { id: "p1" });
  assert.deepEqual(client.getData(["page", "p1"]), { id: "p1" });
  const state = client.getState(["page", "p1"]);
  assert.equal(state.status, "success");
  assert.equal(state.fetching, false);
  assert.equal(state.error, null);
  assert.deepEqual(
    states.map((s) => [s.status, s.fetching]),
    [
      ["pending", true],
      ["success", false],
    ],
  );
});

test("the fetcher gets the key and an AbortSignal", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["tree", "w1", null], fetcher);
  assert.deepEqual(calls[0].key, ["tree", "w1", null]);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("identical requests in flight are deduplicated", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();

  const a = client.fetch(["page", "p1"], fetcher);
  const b = client.fetch(["page", "p1"], fetcher);
  const c = client.fetch(["page", "p1"], fetcher, { force: true });
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  assert.equal(a, c);
  calls[0].resolve("x");
  assert.deepEqual(await Promise.all([a, b, c]), ["x", "x", "x"]);
});

test("structurally equal keys share one entry", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["search", { q: "x", limit: 10 }], fetcher);
  void client.fetch(["search", { limit: 10, q: "x" }], fetcher);
  assert.equal(calls.length, 1);
  calls[0].resolve(["hit"]);
  await flush();
  assert.deepEqual(client.getData(["search", { limit: 10, q: "x" }]), ["hit"]);
  assert.equal(client.size, 1);
});

test("fresh data isn't refetched; stale data is; force ignores freshness", async () => {
  const { client, time } = testClient();
  const { fetcher, calls } = manualFetcher();

  const first = client.fetch(["k"], fetcher, { staleTime: 100 });
  calls[0].resolve(1);
  await first;

  time.advance(50);
  assert.equal(await client.fetch(["k"], fetcher, { staleTime: 100 }), 1);
  assert.equal(calls.length, 1, "still fresh");

  time.advance(50);
  void client.fetch(["k"], fetcher, { staleTime: 100 });
  assert.equal(calls.length, 2, "stale after staleTime");
  calls[1].resolve(2);
  await flush();

  void client.fetch(["k"], fetcher, { staleTime: 100, force: true });
  assert.equal(calls.length, 3, "force refetches fresh data");
});

test("staleTime 0 refetches every time, but data stays visible meanwhile", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["k"], fetcher);
  calls[0].resolve("old");
  await flush();

  void client.fetch(["k"], fetcher);
  assert.equal(calls.length, 2);
  assert.equal(client.getState(["k"]).data, "old");
  assert.equal(client.getState(["k"]).fetching, true);
});

test("errors are stored, keep the previous data, and clear on the next success", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["k"], fetcher);
  calls[0].resolve("good");
  await flush();

  const failing = client.fetch(["k"], fetcher, { force: true });
  const boom = new Error("boom");
  calls[1].reject(boom);
  await assert.rejects(failing, /boom/);
  let state = client.getState(["k"]);
  assert.equal(state.status, "error");
  assert.equal(state.error, boom);
  assert.equal(state.data, "good", "stale data is kept");

  void client.fetch(["k"], fetcher, { force: true });
  calls[2].resolve("better");
  await flush();
  state = client.getState(["k"]);
  assert.equal(state.status, "success");
  assert.equal(state.error, null);
  assert.equal(state.data, "better");
});

test("a fetcher that throws synchronously rejects instead of hanging", async () => {
  const { client } = testClient();
  await assert.rejects(
    client.fetch(["k"], () => {
      throw new Error("sync");
    }),
    /sync/,
  );
  assert.equal(client.getState(["k"]).fetching, false);
  assert.equal(client.getState(["k"]).status, "error");
});

test("fetch without any fetcher rejects", async () => {
  const { client } = testClient();
  await assert.rejects(client.fetch(["k"]), /No fetcher/);
});

test("invalidate refetches observed entries under the prefix and leaves others alone", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  for (const key of [
    ["tree", "w1", null],
    ["tree", "w1", "p1"],
    ["tree", "w2", null],
    ["page", "p1"],
  ]) {
    client.observe(key);
    void client.fetch(key, fetcher);
  }
  for (const call of calls) call.resolve("v1");
  await flush();
  calls.length = 0;

  await Promise.all([
    client.invalidate(["tree", "w1"]),
    Promise.resolve().then(() => calls.forEach((c) => c.resolve("v2"))),
  ]);

  assert.deepEqual(
    calls.map((call) => call.key),
    [
      ["tree", "w1", null],
      ["tree", "w1", "p1"],
    ],
  );
  assert.equal(client.getData(["tree", "w1", null]), "v2");
  assert.equal(client.getData(["tree", "w2", null]), "v1");
});

test("invalidate marks unobserved entries stale without fetching", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["k"], fetcher, { staleTime: 60_000 });
  calls[0].resolve(1);
  await flush();

  await client.invalidate(["k"]);
  assert.equal(calls.length, 1, "nobody observes it: no request");

  void client.fetch(["k"], fetcher, { staleTime: 60_000 });
  assert.equal(calls.length, 2, "the next fetch ignores staleTime");
});

test("invalidate replaces a request in flight and ignores its (older) answer", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.observe(["k"]);
  const first = client.fetch(["k"], fetcher);

  void client.invalidate(["k"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true, "the obsolete request is aborted");

  calls[0].resolve("old");
  calls[1].resolve("new");
  assert.equal(await first, "new", "callers of the first fetch get the newer answer");
  assert.equal(client.getData(["k"]), "new");
});

test("an obsolete request's failure doesn't surface", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.observe(["k"]);
  const first = client.fetch(["k"], fetcher);
  void client.invalidate(["k"]);
  calls[0].reject(new DOMException("Aborted", "AbortError"));
  calls[1].resolve("fine");
  assert.equal(await first, "fine");
  assert.equal(client.getState(["k"]).status, "success");
});

test("setData writes a value or applies a function to the confirmed data", () => {
  const { client } = testClient();
  client.setData(["k"], { n: 1 });
  assert.deepEqual(client.getData(["k"]), { n: 1 });
  assert.equal(client.getState(["k"]).status, "success");

  client.setData(["k"], (/** @type {{ n: number }} */ old) => ({ n: old.n + 1 }));
  assert.deepEqual(client.getData(["k"]), { n: 2 });
});

test("setData returning undefined for a missing entry is a no-op", () => {
  const { client } = testClient();
  client.setData(["missing"], (/** @type {unknown} */ old) => old);
  assert.equal(client.size, 0);
});

test("setData that returns the same value changes nothing and keeps the request in flight", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.setData(["k"], "v1");
  const pending = client.fetch(["k"], fetcher, { force: true });
  /** @type {unknown[]} */
  const seen = [];
  client.observe(["k"], (state) => seen.push(state.data));
  client.setData(["k"], (/** @type {string} */ old) => old);
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(seen, []);
  calls[0].resolve("v2");
  assert.equal(await pending, "v2");
});

test("setData drops a request in flight: its answer predates the write", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  const pending = client.fetch(["k"], fetcher);
  client.setData(["k"], "written");
  calls[0].resolve("from before");
  assert.equal(await pending, "written");
  assert.equal(client.getData(["k"]), "written");
  assert.equal(calls[0].signal.aborted, true);
});

test("observers are notified; unsubscribing stops notifications", () => {
  const { client } = testClient();
  /** @type {unknown[]} */
  const seen = [];
  const stop = client.observe(["k"], (state) => seen.push(state.data));
  client.setData(["k"], 1);
  stop();
  stop(); // idempotent
  client.setData(["k"], 2);
  assert.deepEqual(seen, [1]);
});

test("onChange reports every changed entry by hash", () => {
  const { client } = testClient();
  /** @type {string[]} */
  const hashes = [];
  const off = client.onChange((hash) => hashes.push(hash));
  client.setData(["a"], 1);
  client.setData(["b", { x: 1 }], 2);
  off();
  client.setData(["a"], 3);
  assert.deepEqual(hashes, ['["a"]', '["b",{"x":1}]']);
});

test("a throwing listener doesn't break the others", () => {
  const { client, reported } = testClient();
  let called = false;
  client.observe(["k"], () => {
    throw new Error("listener bug");
  });
  client.observe(["k"], () => (called = true));
  client.setData(["k"], 1);
  assert.equal(called, true);
  assert.equal(reported.length, 1);
});

test("unobserved entries are garbage-collected after gcTime", async () => {
  const { client, time } = testClient({ gcTime: 1000 });
  client.setData(["k"], 1);
  time.advance(999);
  assert.equal(client.size, 1);
  time.advance(1);
  assert.equal(client.size, 0);
});

test("observed entries are kept; gc starts when the last observer leaves", () => {
  const { client, time } = testClient({ gcTime: 1000 });
  const stopA = client.observe(["k"]);
  const stopB = client.observe(["k"]);
  client.setData(["k"], 1);
  time.advance(5000);
  assert.equal(client.size, 1);
  stopA();
  time.advance(5000);
  assert.equal(client.size, 1, "one observer is left");
  stopB();
  time.advance(999);
  assert.equal(client.size, 1);
  const stopC = client.observe(["k"]);
  time.advance(5000);
  assert.equal(client.size, 1, "re-observing cancels the pending gc");
  stopC();
  time.advance(1000);
  assert.equal(client.size, 0);
});

test("gc aborts a request still in flight", () => {
  const { client, time } = testClient({ gcTime: 1000 });
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["k"], fetcher).catch(() => {});
  time.advance(1000);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(client.size, 0);
});

test("keys(prefix) lists cached keys under a prefix", () => {
  const { client } = testClient();
  client.setData(["tree", "w1", null], []);
  client.setData(["tree", "w1", "p1"], []);
  client.setData(["page", "p1"], {});
  assert.deepEqual(client.keys(["tree", "w1"]), [
    ["tree", "w1", null],
    ["tree", "w1", "p1"],
  ]);
  assert.equal(client.keys([]).length, 3);
});

test("layers apply on top of the confirmed data and survive a refetch", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.observe(["list"]);
  void client.fetch(["list"], fetcher);
  calls[0].resolve(["a"]);
  await flush();

  /** @param {string} item */
  const add = (item) => (/** @type {string[] | undefined} */ list) =>
    list && !list.includes(item) ? [...list, item] : list;
  assert.equal(client.setLayer(["list"], "m1", add("b")), true);
  assert.deepEqual(client.getData(["list"]), ["a", "b"]);

  // The server doesn't know about "b" yet, but has a new "c".
  void client.invalidate(["list"]);
  calls[1].resolve(["a", "c"]);
  await flush();
  assert.deepEqual(client.getData(["list"]), ["a", "c", "b"]);
});

test("removing one layer leaves the others (concurrent rollback)", () => {
  const { client } = testClient();
  client.setData(["page"], { title: "A", icon: null });
  client.setLayer(["page"], "rename", (/** @type {any} */ p) => ({ ...p, title: "B" }));
  client.setLayer(["page"], "icon", (/** @type {any} */ p) => ({ ...p, icon: "🌱" }));
  assert.deepEqual(client.getData(["page"]), { title: "B", icon: "🌱" });

  client.removeLayer(["page"], "rename");
  assert.deepEqual(client.getData(["page"]), { title: "A", icon: "🌱" });
});

test("replacing a layer by id updates it in place", () => {
  const { client } = testClient();
  client.setData(["page"], { title: "A" });
  client.setLayer(["page"], "draft", (/** @type {any} */ p) => ({ ...p, title: "Ab" }));
  client.setLayer(["page"], "draft", (/** @type {any} */ p) => ({ ...p, title: "Abc" }));
  assert.deepEqual(client.getData(["page"]), { title: "Abc" });
  client.removeLayer(["page"], "draft");
  assert.deepEqual(client.getData(["page"]), { title: "A" });
});

test("a layer that changes nothing is discarded", () => {
  const { client } = testClient();
  client.setData(["list"], ["a"]);
  const kept = client.setLayer(["list"], "noop", (/** @type {string[]} */ list) => list);
  assert.equal(kept, false);
  client.setData(["list"], ["a", "b"]);
  assert.deepEqual(client.getData(["list"]), ["a", "b"]);
});

test("a layer on an entry still waiting for data is kept for when it arrives", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  void client.fetch(["list"], fetcher);
  const kept = client.setLayer(
    ["list"],
    "m1",
    (/** @type {string[] | undefined} */ list) => list && [...list, "new"],
  );
  assert.equal(kept, true);
  calls[0].resolve(["a"]);
  await flush();
  assert.deepEqual(client.getData(["list"]), ["a", "new"]);
});

test("commitLayer folds the layer into the confirmed data", () => {
  const { client } = testClient();
  client.setData(["page"], { title: "A" });
  client.setLayer(["page"], "m1", (/** @type {any} */ p) => ({ ...p, title: "B" }));
  client.commitLayer(["page"], "m1");
  client.setLayer(["page"], "m2", (/** @type {any} */ p) => ({ ...p, title: "C" }));
  client.removeLayer(["page"], "m2");
  assert.deepEqual(client.getData(["page"]), { title: "B" });
});

test("commitLayer on an entry with only optimistic data makes it confirmed", () => {
  const { client } = testClient();
  client.setLayer(["page", "new"], "create", () => ({ id: "new", title: "" }));
  assert.equal(client.getState(["page", "new"]).status, "pending");
  client.commitLayer(["page", "new"], "create");
  assert.equal(client.getState(["page", "new"]).status, "success");
  assert.deepEqual(client.getData(["page", "new"]), { id: "new", title: "" });
});

test("commitLayer restarts a request that was in flight", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.setData(["page"], { title: "A" });
  client.setLayer(["page"], "m1", (/** @type {any} */ p) => ({ ...p, title: "B" }));
  void client.fetch(["page"], fetcher, { force: true });

  client.commitLayer(["page"], "m1");
  assert.equal(calls.length, 2, "a new request replaces the one that may predate the change");
  calls[0].resolve({ title: "A" });
  calls[1].resolve({ title: "B" });
  await flush();
  assert.deepEqual(client.getData(["page"]), { title: "B" });
});

test("a throwing layer is skipped and reported", () => {
  const { client, reported } = testClient();
  client.setData(["k"], 1);
  client.setLayer(["k"], "bad", () => {
    throw new Error("layer bug");
  });
  client.setLayer(["k"], "good", (/** @type {number} */ n) => n + 1);
  assert.equal(client.getData(["k"]), 2);
  assert.equal(reported.length, 1);
});

test("clearAll drops unobserved entries, resets observed ones, and aborts requests", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.setData(["unobserved"], 1);
  /** @type {unknown[]} */
  const seen = [];
  client.observe(["observed"], (state) => seen.push(state.data));
  const pending = client.fetch(["observed"], fetcher);
  const epoch = client.epoch;

  client.clearAll();

  assert.equal(client.epoch, epoch + 1);
  assert.equal(client.size, 1);
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve("old user's data");
  assert.equal(await pending, undefined);
  assert.equal(client.getData(["observed"]), undefined);
  assert.equal(client.getState(["observed"]).status, "pending");
  assert.equal(seen.at(-1), undefined, "observers were told");
});

test("clearAll: a removed entry's pending fetch rejects with AbortError", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  const pending = client.fetch(["k"], fetcher);
  client.clearAll();
  calls[0].resolve("late");
  await assert.rejects(pending, { name: "AbortError" });
});

test("runInScope runs tasks in the same scope one at a time, in order", async () => {
  const { client } = testClient();
  /** @type {string[]} */
  const log = [];
  const gate = deferred();
  const first = client.runInScope(["page:1"], async () => {
    log.push("first:start");
    await gate.promise;
    log.push("first:end");
    return 1;
  });
  const second = client.runInScope(["page:1"], async () => {
    log.push("second");
    return 2;
  });
  const other = client.runInScope(["page:2"], async () => {
    log.push("other");
    return 3;
  });
  await flush();
  assert.deepEqual(log, ["first:start", "other"]);
  gate.resolve(undefined);
  assert.deepEqual(await Promise.all([first, second, other]), [1, 2, 3]);
  assert.deepEqual(log, ["first:start", "other", "first:end", "second"]);
});

test("runInScope keeps going after a failure", async () => {
  const { client } = testClient();
  const failed = client.runInScope(["s"], async () => {
    throw new Error("nope");
  });
  const next = client.runInScope(["s"], async () => "ok");
  await assert.rejects(failed, /nope/);
  assert.equal(await next, "ok");
});

test("a task in several scopes waits for all of them", async () => {
  const { client } = testClient();
  /** @type {string[]} */
  const log = [];
  const gateA = deferred();
  void client.runInScope(["a"], async () => {
    await gateA.promise;
    log.push("a");
  });
  const both = client.runInScope(["a", "b"], async () => log.push("both"));
  const onlyB = client.runInScope(["b"], async () => log.push("b"));
  await flush();
  assert.deepEqual(log, []);
  gateA.resolve(undefined);
  await Promise.all([both, onlyB]);
  assert.deepEqual(log, ["a", "both", "b"]);
});

test("whenIdle waits for the scope's tasks, including ones queued meanwhile", async () => {
  const { client } = testClient();
  /** @type {string[]} */
  const log = [];
  const gate = deferred();
  void client.runInScope(["s"], () => gate.promise.then(() => log.push("write 1")));
  const idle = client.whenIdle("s").then(() => log.push("idle"));
  void client.runInScope(["s"], async () => log.push("write 2"));
  await flush();
  assert.deepEqual(log, []);
  gate.resolve(undefined);
  await idle;
  assert.deepEqual(log, ["write 1", "write 2", "idle"]);
  await client.whenIdle("nothing-running");
});

test("dehydrate keeps confirmed data only, newest first, up to a limit", () => {
  const { client, time } = testClient();
  client.setData(["a"], 1);
  time.advance(10);
  client.setData(["b"], 2);
  client.setLayer(["b"], "pending", (value) => value + 100);
  client.setLayer(["only-optimistic"], "pending", () => "x");
  const saved = client.dehydrate();
  assert.deepEqual(
    saved.map((item) => [item.key, item.data]),
    [
      [["b"], 2],
      [["a"], 1],
    ],
  );
  assert.equal(client.dehydrate(1).length, 1);
});

test("hydrate shows saved data at once and refetches it on first fetch", async () => {
  const { client } = testClient();
  client.hydrate([{ key: ["page", "p1"], data: { title: "Saved" }, updatedAt: 5 }]);
  const state = client.getState(["page", "p1"]);
  assert.equal(state.status, "success");
  assert.deepEqual(state.data, { title: "Saved" });

  let calls = 0;
  const fresh = await client.fetch(
    ["page", "p1"],
    async () => {
      calls++;
      return { title: "Fresh" };
    },
    { staleTime: 60_000 },
  );
  assert.equal(calls, 1, "restored entries count as stale");
  assert.deepEqual(fresh, { title: "Fresh" });
});

test("hydrate never overwrites data the cache already has", () => {
  const { client } = testClient();
  client.setData(["k"], "live");
  client.hydrate([
    { key: ["k"], data: "saved", updatedAt: 0 },
    { key: "not-a-key", data: 1, updatedAt: 0 },
  ]);
  assert.equal(client.getData(["k"]), "live");
  assert.equal(client.size, 1);
});
