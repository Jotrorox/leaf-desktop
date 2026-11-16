// @ts-check
import { createDb } from "./db.js";
import { seedState } from "./seed.js";
import { ROADMAP_ID } from "./seed-database.js";
import { createMockServer, DEFAULT_MOCK_CONFIG } from "./server.js";
import { createMockSync } from "./sync.js";

/**
 * The mock backend as the browser app uses it (`VITE_API_MOCK=1`).
 *
 * Its data lives in memory and is mirrored to sessionStorage, so a reload
 * keeps what you did (this tab only; reset from the dev menu). The keys
 * start with `leaf-mock:`, not `leaf.`, so sign-out (which clears `leaf.*`)
 * leaves the "server" alone.
 *
 * The dev menu can also change your role on every page, to see read-only
 * pages ("view" or "comment").
 *
 * Latency and failure injection start from `VITE_API_MOCK_LATENCY` (ms)
 * and `VITE_API_MOCK_FAIL_EVERY` (N), and can be changed at runtime from the
 * sidebar's "Mock API" menu or the console: `leafMock.configure({ failEvery: 3 })`.
 */

/** @typedef {import("./server.js").MockConfig} MockConfig */

const DB_KEY = "leaf-mock:db";
const CONFIG_KEY = "leaf-mock:config";

/** @type {MockConfig} */
let config = { ...envConfig(), .../** @type {Partial<MockConfig>} */ (load(CONFIG_KEY) ?? {}) };
const dbOptions = { role: () => config.role ?? "owner" };
let db = createDb(
  /** @type {import("./db.js").DbState | undefined} */ (load(DB_KEY)) ??
    seedState(new Date(), { database: true }),
  dbOptions,
);
/** @type {Set<(config: MockConfig) => void>} */
const listeners = new Set();

const sync = createMockSync({
  db: () => db,
  latency: () => config.latency,
  offline: () => config.offline === true,
  onWrite: () => save(DB_KEY, db.snapshot()),
});

/**
 * Uploaded files' bytes, as data URLs: in memory, and in sessionStorage
 * when they fit (so a reload keeps them, mostly). @type {Map<string, string>}
 */
const fileData = new Map();
const FILE_KEY = "leaf-mock:file:";

const server = createMockServer({
  db: () => db,
  config: () => config,
  onWrite: () => {
    save(DB_KEY, db.snapshot());
    // Open pages that went to the trash (or away) hear about it.
    sync.refresh();
  },
  onFile: (id, file) => {
    // An object URL works at once; the data URL (for storage) follows.
    fileData.set(id, URL.createObjectURL(file));
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      try {
        sessionStorage.setItem(FILE_KEY + id, reader.result);
      } catch {
        // Too big for sessionStorage: it lasts until a reload.
      }
    };
    reader.readAsDataURL(file);
  },
});

/** @param {string} id */
function mockFileUrl(id) {
  const known = fileData.get(id);
  if (known) return known;
  try {
    const stored = sessionStorage.getItem(FILE_KEY + id);
    if (stored) fileData.set(id, stored);
    return stored;
  } catch {
    return null;
  }
}

/** The transport `api/transport.js` uses in mock mode, live sync (`api/sync.js`) and files (`api/files.js`). */
export const mockApi = {
  request: server.request,
  connectSync: sync.connect,
  putFile: server.putFile,
  fileUrl: mockFileUrl,
};

export const mockControls = {
  /** @returns {MockConfig} */
  get config() {
    return config;
  },

  /** @param {Partial<MockConfig>} next */
  configure(next) {
    config = { ...config, ...next };
    if (config.offline) sync.dropAll();
    server.resetWriteCount();
    save(CONFIG_KEY, config);
    for (const listener of [...listeners]) listener(config);
  },

  /** @param {(config: MockConfig) => void} listener @returns {() => void} */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Adds made-up rows to a database (default: the sample one), to try a
   * big table. Returns how many it has now.
   * @param {string} [databaseId]
   * @param {number} [count]
   */
  fillDatabase(databaseId = ROADMAP_ID, count = 5000) {
    const total = db.addGeneratedRows(databaseId, count);
    save(DB_KEY, db.snapshot());
    return total;
  },

  /** Puts the seed data back. */
  reset() {
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith(FILE_KEY)) sessionStorage.removeItem(key);
    } catch {
      // Nothing stored.
    }
    fileData.clear();
    db = createDb(seedState(new Date(), { database: true }), dbOptions);
    save(DB_KEY, db.snapshot());
    sync.dropAll();
  },
};

/** @type {any} */ (globalThis).leafMock = mockControls;
console.info(
  "%cleaf%c mock API is on (VITE_API_MOCK=1). Data lives in this tab. Console: leafMock.configure({ latency, failEvery }), leafMock.reset()",
  "font-weight:bold",
  "",
);

/** @returns {MockConfig} */
function envConfig() {
  const latency = Number(import.meta.env.VITE_API_MOCK_LATENCY);
  const failEvery = Number(import.meta.env.VITE_API_MOCK_FAIL_EVERY);
  return {
    latency: Number.isFinite(latency) && latency >= 0 ? latency : DEFAULT_MOCK_CONFIG.latency,
    failEvery:
      Number.isInteger(failEvery) && failEvery >= 0 ? failEvery : DEFAULT_MOCK_CONFIG.failEvery,
    offline: false,
  };
}

/** @param {string} key */
function load(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} key @param {unknown} value */
function save(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory state still works until a reload.
  }
}
