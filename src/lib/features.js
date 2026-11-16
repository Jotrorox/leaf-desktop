// @ts-check

/**
 * Optional features, chosen at build time. Each is off unless its variable is "1".
 *
 * AI_ASSISTANTS (`VITE_AI_ASSISTANTS=1`): connecting AI assistants through
 * leaf-mcp. Turns on the /connect guide, its footer link, Settings → Connected
 * apps, sign-in returning to Clerk's OAuth pages, and the "Connecting AI
 * assistants" sections of the privacy policy and terms. Leave it off until
 * leaf-mcp is deployed and accepted (leaf-mcp/docs/M6.md).
 */
export const AI_ASSISTANTS = import.meta.env?.VITE_AI_ASSISTANTS === "1";

/**
 * The publishable key that lets sign-in return to Clerk's `/oauth/` pages, or
 * "" (no OAuth returns) while AI assistants are off.
 */
export const OAUTH_RETURN_KEY = AI_ASSISTANTS
  ? (import.meta.env?.VITE_CLERK_PUBLISHABLE_KEY ?? "")
  : "";
