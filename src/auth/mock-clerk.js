// @ts-check

/**
 * A stand-in for Clerk in mock mode (`VITE_API_MOCK=1`), so the app runs
 * with no Clerk instance and no backend. It implements the slice of Clerk's
 * browser API that `clerk.js` uses; there's a single "Mock User", and the
 * sign-in page is one button. Signing out is remembered for the tab.
 */

const SIGNED_OUT_KEY = "leaf-mock:signed-out";

/** @returns {import("./clerk.js").ClerkInstance} */
export function createMockClerk() {
  let signedIn = !readSignedOut();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const user = {
    id: "user_mock",
    fullName: "Mock User",
    username: null,
    primaryEmailAddress: { emailAddress: "mock@leaf.test" },
    hasImage: false,
    imageUrl: "",
  };
  const session = { getToken: async () => "mock-session-token" };

  /** @param {boolean} value */
  function setSignedIn(value) {
    signedIn = value;
    writeSignedOut(!value);
    for (const listener of [...listeners]) listener();
  }

  /** @param {HTMLElement} el */
  function mountButton(el) {
    const card = document.createElement("div");
    card.style.cssText =
      "display:flex;flex-direction:column;gap:12px;width:min(360px,100%);padding:24px;border-radius:12px;background:var(--color-bg-elevated);box-shadow:var(--shadow-lg);text-align:center";
    const text = document.createElement("p");
    text.textContent = "Mock mode: no real sign-in. You'll use the mock API as Mock User.";
    text.style.cssText = "color:var(--color-text-secondary);font-size:var(--font-size-sm)";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Continue as Mock User";
    button.style.cssText =
      "height:36px;border:none;border-radius:6px;background:var(--color-accent);color:var(--color-text-on-accent);font-weight:500";
    button.addEventListener("click", () => setSignedIn(true));
    card.append(text, button);
    el.replaceChildren(card);
    button.focus();
  }

  return {
    async load() {},
    get isSignedIn() {
      return signedIn;
    },
    get user() {
      return signedIn ? user : null;
    },
    get session() {
      return signedIn ? session : null;
    },
    addListener(callback) {
      listeners.add(callback);
      // Clerk calls back right away with the current state.
      callback();
      return () => listeners.delete(callback);
    },
    async signOut() {
      setSignedIn(false);
    },
    mountSignIn: mountButton,
    unmountSignIn: (el) => el.replaceChildren(),
    mountSignUp: mountButton,
    unmountSignUp: (el) => el.replaceChildren(),
  };
}

function readSignedOut() {
  try {
    return sessionStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

/** @param {boolean} value */
function writeSignedOut(value) {
  try {
    if (value) sessionStorage.setItem(SIGNED_OUT_KEY, "1");
    else sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // Not remembered across reloads.
  }
}
