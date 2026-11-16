// @ts-check

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ApiError, createApiClient } from "./client.js";

const realFetch = globalThis.fetch;

/** @type {{ url: string, init: RequestInit & { headers: Headers } }[]} */
let calls;

/**
 * Replaces globalThis.fetch with a stub that records calls and returns `respond()`.
 * @param {(url: string, init: RequestInit) => Response | Promise<Response>} respond
 */
function stubFetch(respond) {
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init: /** @type {any} */ (init) });
    return respond(String(input), init);
  };
}

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("GET joins base URL and path and parses JSON", async () => {
  stubFetch(() => json({ id: "p1" }));
  const api = createApiClient({ baseUrl: "https://api.test/" });

  const data = await api.get("/v1/pages/p1");

  assert.deepEqual(data, { id: "p1" });
  assert.equal(calls[0].url, "https://api.test/v1/pages/p1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.get("Accept"), "application/json");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.has("Content-Type"), false);
});

test("POST sends a JSON body with Content-Type", async () => {
  stubFetch(() => json({ ok: true }, 201));
  const api = createApiClient({ baseUrl: "https://api.test" });

  await api.post("/v1/pages", { title: "Hello" });

  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, '{"title":"Hello"}');
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
});

test("empty responses resolve to undefined", async () => {
  stubFetch(() => new Response(null, { status: 204 }));
  const api = createApiClient();

  assert.equal(await api.delete("/v1/pages/p1"), undefined);
});

test("non-2xx responses throw ApiError with code and message from the body", async () => {
  stubFetch(() => json({ error: { code: "not_found", message: "Page not found" } }, 404));
  const api = createApiClient();

  await assert.rejects(api.get("/v1/pages/missing"), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.code, "not_found");
    assert.equal(err.message, "Page not found");
    return true;
  });
});

test("flat error bodies are understood too", async () => {
  stubFetch(() => json({ code: "forbidden", message: "Nope" }, 403));
  const api = createApiClient();

  await assert.rejects(api.get("/x"), {
    name: "ApiError",
    status: 403,
    code: "forbidden",
    message: "Nope",
  });
});

test("non-JSON error bodies fall back to status code and text", async () => {
  stubFetch(() => new Response("upstream down", { status: 502, statusText: "Bad Gateway" }));
  const api = createApiClient();

  await assert.rejects(api.get("/x"), {
    name: "ApiError",
    status: 502,
    code: "http_502",
    message: "Bad Gateway",
  });
});

test("network failures become ApiError with status 0", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const api = createApiClient();

  await assert.rejects(api.get("/x"), { name: "ApiError", status: 0, code: "network_error" });
});

test("passes the AbortSignal through and rethrows aborts unchanged", async () => {
  stubFetch((_url, init) => {
    init.signal?.throwIfAborted();
    return json({});
  });
  const api = createApiClient();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(api.get("/x", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls[0].init.signal, controller.signal);
});

test("token provider adds a bearer token; without a provider no header is sent", async () => {
  stubFetch(() => json({}));
  const api = createApiClient();

  api.setTokenProvider(async () => "tok_123");
  await api.get("/v1/me");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer tok_123");

  api.setTokenProvider(null);
  await api.get("/health");
  assert.equal(calls[1].init.headers.has("Authorization"), false);
});

test("with a provider but no token, nothing is sent", async () => {
  stubFetch(() => json({}));
  const api = createApiClient();
  api.setTokenProvider(() => null);

  await assert.rejects(api.get("/v1/me"), { name: "ApiError", status: 401, code: "signed_out" });
  assert.equal(calls.length, 0);
});

test("with anonymous requests allowed, a signed-out client sends without a token and never signs out", async () => {
  stubFetch((url) =>
    url.endsWith("/v1/pages/p1")
      ? json({ id: "p1" })
      : json({ error: { code: "unauthorized" } }, 401),
  );
  const api = createApiClient();
  let unauthorized = 0;
  api.setTokenProvider(() => null);
  api.setUnauthorizedHandler(() => unauthorized++);
  api.setAnonymousAllowed(true);

  assert.deepEqual(await api.get("/v1/pages/p1"), { id: "p1" });
  assert.equal(calls[0].init.headers.get("Authorization"), null);
  await assert.rejects(api.get("/v1/workspaces"), { status: 401, code: "unauthorized" });
  assert.equal(calls.length, 2, "no retry");
  assert.equal(unauthorized, 0);

  api.setAnonymousAllowed(false);
  await assert.rejects(api.get("/v1/pages/p1"), { status: 401, code: "signed_out" });
  assert.equal(calls.length, 2);
});

test("a throwing provider becomes ApiError, and nothing is sent", async () => {
  stubFetch(() => json({}));
  const api = createApiClient();
  api.setTokenProvider(() => {
    throw new Error("clerk offline");
  });

  await assert.rejects(api.get("/v1/me"), {
    name: "ApiError",
    status: 0,
    code: "token_unavailable",
  });
  assert.equal(calls.length, 0);
});

test("on 401, refreshes the token and retries once", async () => {
  stubFetch((_url, init) =>
    new Headers(init.headers).get("Authorization") === "Bearer fresh"
      ? json({ id: "u1" })
      : json({}, 401),
  );
  const api = createApiClient();
  /** @type {boolean[]} */
  const refreshes = [];
  api.setTokenProvider(({ forceRefresh }) => {
    refreshes.push(forceRefresh);
    return forceRefresh ? "fresh" : "stale";
  });
  let unauthorized = 0;
  api.setUnauthorizedHandler(() => unauthorized++);

  const data = await api.post("/v1/pages", { title: "Hi" });

  assert.deepEqual(data, { id: "u1" });
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.body, '{"title":"Hi"}');
  assert.equal(unauthorized, 0);
});

test("a second 401 calls the unauthorized handler and throws", async () => {
  stubFetch(() => json({ error: { code: "unauthorized", message: "Bad token" } }, 401));
  const api = createApiClient();
  api.setTokenProvider(() => "tok");
  let unauthorized = 0;
  api.setUnauthorizedHandler(() => unauthorized++);

  await assert.rejects(api.get("/v1/me"), { name: "ApiError", status: 401, code: "unauthorized" });
  assert.equal(calls.length, 2);
  assert.equal(unauthorized, 1);
});

test("401 without a token provider is not retried", async () => {
  stubFetch(() => json({}, 401));
  const api = createApiClient();
  let unauthorized = 0;
  api.setUnauthorizedHandler(() => unauthorized++);

  await assert.rejects(api.get("/x"), { status: 401 });
  assert.equal(calls.length, 1);
  assert.equal(unauthorized, 0);
});

test("other errors are not retried", async () => {
  stubFetch(() => json({}, 403));
  const api = createApiClient();
  api.setTokenProvider(() => "tok");

  await assert.rejects(api.get("/x"), { status: 403 });
  assert.equal(calls.length, 1);
});

test("caller headers are kept", async () => {
  stubFetch(() => json({}));
  const api = createApiClient();

  await api.get("/x", { headers: { "X-Request-Id": "abc" } });

  assert.equal(calls[0].init.headers.get("X-Request-Id"), "abc");
});
