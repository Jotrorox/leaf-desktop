// @ts-check
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real Go server for opt-in tests against it (`src/editor/sync/interop.test.js`,
 * `src/databases/interop.test.js`): the backend's TestInteropServer, which
 * serves the API on Postgres with the tests' header auth (X-Test-User)
 * instead of Clerk. It seeds user_1 as the owner, user_2 as an editor and
 * user_viewer as a viewer of one workspace. Node only.
 *
 *   LEAF_BACKEND_DIR=../leaf-backend
 *   LEAF_INTEROP_DATABASE_URL="postgres:///leaf_interop?host=/tmp"
 *   LEAF_INTEROP_PORT=8099 (the default)
 */

export const backendDir = process.env.LEAF_BACKEND_DIR;
export const databaseUrl = process.env.LEAF_INTEROP_DATABASE_URL;
export const port = Number(process.env.LEAF_INTEROP_PORT || 8099);
export const base = `http://127.0.0.1:${port}`;
export const USER = "user_1";

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A request as a user; rejects with `{ status, code }` on an error answer.
 * @param {string} method @param {string} path @param {unknown} [body]
 * @param {{ keepalive?: boolean, user?: string | null, email?: string }} [options] `user` null: anonymous.
 *   `email`: the email the session would carry.
 */
export async function api(method, path, body, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (options.user !== null) headers["X-Test-User"] = options.user ?? USER;
  if (options.email) headers["X-Test-Email"] = options.email;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: options.keepalive,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok)
    throw Object.assign(new Error(`${method} ${path}: ${res.status}`), {
      status: res.status,
      code: json?.error?.code,
    });
  return json;
}

/** The backend's TestInteropServer, started and stopped as a process. */
export function server() {
  const bin = join(mkdtempSync(join(tmpdir(), "leaf-interop-")), "leaf.test");
  const built = spawnSync("go", ["test", "-c", "-o", bin], { cwd: backendDir, stdio: "inherit" });
  if (built.status !== 0) throw new Error("building the backend's test binary failed");
  /** @type {import("node:child_process").ChildProcess | null} */
  let proc = null;
  return {
    async start() {
      proc = spawn(bin, ["-test.run", "^TestInteropServer$"], {
        env: {
          ...process.env,
          LEAF_INTEROP_ADDR: `127.0.0.1:${port}`,
          LEAF_INTEROP_DATABASE_URL: databaseUrl,
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
      const until = Date.now() + 15_000;
      for (;;) {
        try {
          await api("GET", "/v1/workspaces");
          return;
        } catch {
          if (Date.now() > until) throw new Error("the backend didn't come up");
          await sleep(50);
        }
      }
    },
    /** @param {NodeJS.Signals} signal */
    async stop(signal) {
      const p = proc;
      proc = null;
      if (!p || p.exitCode !== null) return;
      const exited = new Promise((r) => p.once("exit", r));
      p.kill(signal);
      await exited;
    },
  };
}
