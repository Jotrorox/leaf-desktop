// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMutation } from "./mutation.js";
import { deferred, flush, manualFetcher, testClient } from "./testing.js";

/** @typedef {{ id: string, title: string }} Item */

/**
 * Sets one item's title; returns the same list when nothing changes, as
 * layer updaters must.
 * @param {string} id @param {string} title
 */
const retitle = (id, title) => (/** @type {Item[] | undefined} */ list) => {
  if (!list?.some((item) => item.id === id && item.title !== title)) return list;
  return list.map((item) => (item.id === id ? { ...item, title } : item));
};

/**
 * A mutation whose server calls the test settles by hand.
 * @param {import("./core.js").QueryClient} client
 * @param {Partial<import("./mutation.js").MutationOptions<{ id: string, title: string }, string>>} [options]
 */
function renameMutation(client, options = {}) {
  /** @type {{ vars: { id: string, title: string }, resolve: (value: string) => void, reject: (error: unknown) => void }[]} */
  const requests = [];
  const mutation = createMutation(client, {
    mutationFn(vars) {
      const { promise, resolve, reject } = deferred();
      requests.push({ vars, resolve, reject });
      return /** @type {Promise<string>} */ (promise);
    },
    optimistic(vars, tx) {
      tx.update(["list"], retitle(vars.id, vars.title));
    },
    ...options,
  });
  return { mutation, requests };
}

test("the optimistic update shows at once and stays after success", async () => {
  const { client } = testClient();
  client.setData(["list"], [{ id: "a", title: "A" }]);
  /** @type {unknown[]} */
  const successes = [];
  const { mutation, requests } = renameMutation(client, {
    onSuccess: (result) => successes.push(result),
  });

  const run = mutation.mutate({ id: "a", title: "B" });
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "B" }]);
  await flush();
  requests[0].resolve("ok");
  assert.equal(await run, "ok");
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "B" }]);
  assert.deepEqual(successes, ["ok"]);

  // Committed: a later rollback of another mutation doesn't undo it.
  client.setLayer(["list"], "other", retitle("a", "C"));
  client.removeLayer(["list"], "other");
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "B" }]);
});

test("a failure rolls back, refetches what it touched, calls onError and rejects", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.observe(["list"]);
  void client.fetch(["list"], fetcher);
  calls[0].resolve([{ id: "a", title: "A" }]);
  await flush();

  /** @type {unknown[]} */
  const errors = [];
  const { mutation, requests } = renameMutation(client, { onError: (error) => errors.push(error) });
  const run = mutation.mutate({ id: "a", title: "B" });
  await flush();
  const failure = new Error("server said no");
  requests[0].reject(failure);

  await assert.rejects(run, /server said no/);
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "A" }], "rolled back");
  assert.deepEqual(errors, [failure]);
  assert.equal(calls.length, 2, "the touched entry is refetched");
});

test("rolling back one mutation keeps another pending one's change", async () => {
  const { client } = testClient();
  client.setData(
    ["list"],
    [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
  );
  const { mutation, requests } = renameMutation(client);

  const first = mutation.mutate({ id: "a", title: "A2" });
  const second = mutation.mutate({ id: "b", title: "B2" });
  await flush();
  assert.deepEqual(client.getData(["list"]), [
    { id: "a", title: "A2" },
    { id: "b", title: "B2" },
  ]);

  requests[0].reject(new Error("no"));
  await assert.rejects(first);
  assert.deepEqual(client.getData(["list"]), [
    { id: "a", title: "A" },
    { id: "b", title: "B2" },
  ]);

  requests[1].resolve("ok");
  await second;
  assert.deepEqual(client.getData(["list"]), [
    { id: "a", title: "A" },
    { id: "b", title: "B2" },
  ]);
});

test("two edits to the same field: the later one wins, and failing the earlier one keeps the later", async () => {
  const { client } = testClient();
  client.setData(["list"], [{ id: "a", title: "A" }]);
  const { mutation, requests } = renameMutation(client);
  const first = mutation.mutate({ id: "a", title: "Ab" });
  const second = mutation.mutate({ id: "a", title: "Abc" });
  await flush();
  requests[0].reject(new Error("no"));
  await assert.rejects(first);
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "Abc" }]);
  requests[1].resolve("ok");
  await second;
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "Abc" }]);
});

test("a refetch while the mutation is pending keeps the optimistic change", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.observe(["list"]);
  void client.fetch(["list"], fetcher);
  calls[0].resolve([{ id: "a", title: "A" }]);
  await flush();

  const { mutation, requests } = renameMutation(client);
  const run = mutation.mutate({ id: "a", title: "B" });
  void client.invalidate(["list"]);
  calls[1].resolve([
    { id: "a", title: "A" },
    { id: "z", title: "Z" },
  ]);
  await flush();
  assert.deepEqual(client.getData(["list"]), [
    { id: "a", title: "B" },
    { id: "z", title: "Z" },
  ]);
  requests[0].resolve("ok");
  await run;
});

test("mutations in the same scope reach the server in order, one at a time", async () => {
  const { client } = testClient();
  client.setData(["list"], [{ id: "a", title: "A" }]);
  const { mutation, requests } = renameMutation(client, { scope: (vars) => `page:${vars.id}` });

  const first = mutation.mutate({ id: "a", title: "1" });
  const second = mutation.mutate({ id: "a", title: "2" });
  const other = mutation.mutate({ id: "b", title: "x" });
  await flush();
  assert.deepEqual(
    requests.map((r) => r.vars.title),
    ["1", "x"],
    "the second waits for the first; another scope doesn't",
  );
  requests[0].resolve("ok");
  await first;
  await flush();
  assert.deepEqual(
    requests.map((r) => r.vars.title),
    ["1", "x", "2"],
  );
  requests[1].resolve("ok");
  requests[2].resolve("ok");
  await Promise.all([second, other]);
});

test("a failed mutation doesn't block the next one in its scope", async () => {
  const { client } = testClient();
  client.setData(["list"], [{ id: "a", title: "A" }]);
  const { mutation, requests } = renameMutation(client, { scope: () => "s" });
  const first = mutation.mutate({ id: "a", title: "1" });
  const second = mutation.mutate({ id: "a", title: "2" });
  await flush();
  requests[0].reject(new Error("no"));
  await assert.rejects(first);
  await flush();
  requests[1].resolve("ok");
  assert.equal(await second, "ok");
  assert.deepEqual(client.getData(["list"]), [{ id: "a", title: "2" }]);
});

test("a fetcher that waits for the scope reads its own writes", async () => {
  const { client } = testClient();
  /** @type {string[]} */
  const log = [];
  const { mutation, requests } = renameMutation(client, { scope: () => "page:a" });
  client.setData(["list"], [{ id: "a", title: "A" }]);
  void mutation.mutate({ id: "a", title: "B" });
  const read = client.fetch(["page", "a"], async () => {
    await client.whenIdle("page:a");
    log.push("GET");
    return "fresh";
  });
  await flush();
  assert.deepEqual(log, []);
  requests[0].resolve("ok");
  assert.equal(await read, "fresh");
});

test("clearAll while a mutation is in flight: no rollback, no callbacks, nothing written back", async () => {
  const { client } = testClient();
  client.setData(["list"], [{ id: "a", title: "A" }]);
  let errors = 0;
  let successes = 0;
  const { mutation, requests } = renameMutation(client, {
    onError: () => errors++,
    onSuccess: () => successes++,
    invalidates: () => [["list"]],
  });

  const failing = mutation.mutate({ id: "a", title: "B" });
  const succeeding = mutation.mutate({ id: "a", title: "C" });
  await flush();
  client.clearAll();
  requests[0].reject(new Error("no"));
  requests[1].resolve("ok");
  await assert.rejects(failing);
  await succeeding;

  assert.equal(client.getData(["list"]), undefined);
  assert.equal(client.size, 0);
  assert.equal(errors, 0);
  assert.equal(successes, 0);
});

test("an optimistic update can create an entry (a new page) and the commit confirms it", async () => {
  const { client } = testClient();
  const gate = deferred();
  const create = createMutation(client, {
    mutationFn: async (/** @type {{ id: string }} */ vars) => {
      await gate.promise;
      return { id: vars.id, title: "" };
    },
    optimistic(vars, tx) {
      tx.update(["page", vars.id], () => ({ id: vars.id, title: "" }));
    },
  });
  const run = create.mutate({ id: "new" });
  assert.deepEqual(client.getData(["page", "new"]), { id: "new", title: "" });
  gate.resolve(undefined);
  await run;
  assert.equal(client.getState(["page", "new"]).status, "success");
});

test("onSuccess can write the server's answer", async () => {
  const { client } = testClient();
  client.setData(["page", "a"], { id: "a", title: "A", updated: 1 });
  const update = createMutation(client, {
    mutationFn: async (/** @type {{ title: string }} */ vars) => ({
      id: "a",
      title: vars.title,
      updated: 2,
    }),
    optimistic(vars, tx) {
      tx.update(["page", "a"], (/** @type {any} */ page) => ({ ...page, title: vars.title }));
    },
    onSuccess(result) {
      client.setData(["page", "a"], result);
    },
  });
  await update.mutate({ title: "B" });
  assert.deepEqual(client.getData(["page", "a"]), { id: "a", title: "B", updated: 2 });
});

test("updateAll changes every matching entry and only keeps layers that change something", async () => {
  const { client } = testClient();
  client.setData(["tree", "w", null], [{ id: "a", title: "A" }]);
  client.setData(["tree", "w", "a"], [{ id: "b", title: "B" }]);
  client.setData(["tree", "other", null], [{ id: "b", title: "B" }]);
  const gate = deferred();
  const rename = createMutation(client, {
    mutationFn: () => gate.promise.then(() => "ok"),
    optimistic(/** @type {{ id: string, title: string }} */ vars, tx) {
      tx.updateAll(["tree", "w"], retitle(vars.id, vars.title));
    },
  });
  const { fetcher, calls } = manualFetcher();
  for (const key of client.keys(["tree"])) {
    client.observe(key);
    void client.fetch(key, fetcher, { staleTime: Infinity });
  }
  assert.equal(calls.length, 0, "all fresh");

  const run = rename.mutate({ id: "b", title: "B2" });
  assert.deepEqual(client.getData(["tree", "w", "a"]), [{ id: "b", title: "B2" }]);
  assert.deepEqual(
    client.getData(["tree", "other", null]),
    [{ id: "b", title: "B" }],
    "outside the prefix",
  );
  gate.reject(new Error("no"));
  await assert.rejects(run);
  assert.deepEqual(client.getData(["tree", "w", "a"]), [{ id: "b", title: "B" }]);
  assert.deepEqual(
    calls.map((call) => call.key),
    [["tree", "w", "a"]],
    "only the entry it actually changed is refetched",
  );
});

test("several updates to one entry in one mutation compose, in order", async () => {
  const { client } = testClient();
  client.setData(
    ["list"],
    [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
  );
  const gate = deferred();
  const mutation = createMutation(client, {
    mutationFn: () => gate.promise,
    optimistic(_vars, tx) {
      tx.update(["list"], retitle("a", "A2"));
      // Touches the same entry again, e.g. a helper that patches every list.
      tx.updateAll(["list"], retitle("b", "B2"));
      tx.update(["list"], (/** @type {Item[]} */ list) => list);
    },
  });
  const run = mutation.mutate(undefined);
  assert.deepEqual(client.getData(["list"]), [
    { id: "a", title: "A2" },
    { id: "b", title: "B2" },
  ]);
  gate.reject(new Error("no"));
  await assert.rejects(run);
  assert.deepEqual(client.getData(["list"]), [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
});

test("a throwing optimistic update rolls back what it did and fails the mutation", async () => {
  const { client } = testClient();
  client.setData(["a"], 1);
  let called = false;
  let errors = 0;
  const mutation = createMutation(client, {
    mutationFn: async () => {
      called = true;
    },
    optimistic(_vars, tx) {
      tx.update(["a"], (/** @type {number} */ n) => n + 1);
      throw new Error("bug");
    },
    onError: () => errors++,
  });
  await assert.rejects(mutation.mutate(undefined), /bug/);
  assert.equal(client.getData(["a"]), 1);
  assert.equal(called, false);
  assert.equal(errors, 1);
});

test("invalidates runs after settling, on success and on failure", async () => {
  const { client } = testClient();
  const { fetcher, calls } = manualFetcher();
  client.observe(["trash"]);
  void client.fetch(["trash"], fetcher);
  calls[0].resolve([]);
  await flush();

  let fail = false;
  const mutation = createMutation(client, {
    mutationFn: async () => {
      if (fail) throw new Error("no");
    },
    invalidates: () => [["trash"]],
  });
  await mutation.mutate(undefined);
  assert.equal(calls.length, 2);
  fail = true;
  await assert.rejects(mutation.mutate(undefined));
  assert.equal(calls.length, 3);
});

test("pending counts runs in flight and notifies subscribers", async () => {
  const { client } = testClient();
  const gate = deferred();
  const mutation = createMutation(client, { mutationFn: () => gate.promise });
  /** @type {number[]} */
  const seen = [];
  mutation.subscribe(() => seen.push(mutation.pending));
  const a = mutation.mutate(undefined);
  const b = mutation.mutate(undefined);
  assert.equal(mutation.pending, 2);
  gate.resolve(undefined);
  await Promise.all([a, b]);
  assert.equal(mutation.pending, 0);
  assert.deepEqual(seen, [1, 2, 1, 0]);
});

test("callback errors are reported, not turned into a failed mutation", async () => {
  const { client, reported } = testClient();
  client.setData(["a"], 1);
  const mutation = createMutation(client, {
    mutationFn: async () => "ok",
    optimistic: (_vars, tx) => tx.update(["a"], () => 2),
    onSuccess: () => {
      throw new Error("callback bug");
    },
  });
  assert.equal(await mutation.mutate(undefined), "ok");
  assert.equal(client.getData(["a"]), 2, "still committed");
  assert.equal(reported.length, 1);
});
