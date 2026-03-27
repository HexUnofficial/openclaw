// Shim: re-exports light WhatsApp runtime from the channel runtime setup chunk.
// Loaded by runtime-whatsapp-boundary via jiti for auth/status checks.

export {
  getActiveWebListener,
  getWebAuthAgeMs,
  logWebSelfId,
  logoutWeb,
  readWebSelfId,
  webAuthExists
} from "../../channel.runtime-DrdPXdoQ.js";

export function createWhatsAppLoginTool() {
  return {
    name: "whatsapp_login",
    description: "Login to WhatsApp Web (use openclaw channels login --channel whatsapp instead)",
    parameters: {},
    execute: async () => ({ error: "Use CLI: openclaw channels login --channel whatsapp" })
  };
}

export const WA_WEB_AUTH_DIR = undefined;
export function pickWebChannel() { return undefined; }
export function formatError(err) { return String(err); }
export function getStatusCode() { return undefined; }