// Shim: re-exports heavy WhatsApp runtime from the channel runtime setup chunk.
// Loaded by runtime-whatsapp-boundary via jiti for send/login/monitor.

import {
  getActiveWebListener,
  getWebAuthAgeMs,
  logWebSelfId,
  loginWeb,
  logoutWeb,
  monitorWebChannel,
  readWebSelfId,
  startWebLoginWithQr,
  waitForWebLogin,
  webAuthExists
} from "../../channel.runtime-DrdPXdoQ.js";

export {
  getActiveWebListener,
  getWebAuthAgeMs,
  logWebSelfId,
  loginWeb,
  logoutWeb,
  monitorWebChannel,
  readWebSelfId,
  startWebLoginWithQr,
  waitForWebLogin,
  webAuthExists
};

export { createWhatsAppLoginTool, formatError, getStatusCode, pickWebChannel, WA_WEB_AUTH_DIR } from "./light-runtime-api.js";

// Send functions using the active web listener (Baileys socket)
export async function sendMessageWhatsApp(to, body, options = {}) {
  const listener = getActiveWebListener(options.accountId);
  if (!listener) throw new Error("WhatsApp is not connected (no active web listener)");

  let mediaBuffer, mediaType;
  if (options.mediaUrl) {
    const url = options.mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
    if (/^https?:\/\//i.test(url)) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status} ${resp.statusText}`);
      mediaBuffer = Buffer.from(await resp.arrayBuffer());
      mediaType = resp.headers.get("content-type") || "application/octet-stream";
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      let filePath = url;
      if (filePath.startsWith("file://")) {
        const { fileURLToPath } = await import("node:url");
        filePath = fileURLToPath(filePath);
      }
      if (filePath.startsWith("~")) {
        const os = await import("node:os");
        filePath = path.join(os.homedir(), filePath.slice(1));
      }
      mediaBuffer = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
        ".mp3": "audio/mpeg", ".ogg": "audio/ogg; codecs=opus", ".pdf": "application/pdf"
      };
      mediaType = mimeMap[ext] || "application/octet-stream";
    }
  }

  const result = await listener.sendMessage(to, body || "", mediaBuffer, mediaType, {
    gifPlayback: options.gifPlayback,
    accountId: options.accountId,
    fileName: options.fileName
  });
  return { messageId: result?.messageId || "unknown", toJid: to };
}

export async function sendPollWhatsApp(to, poll, options = {}) {
  const listener = getActiveWebListener(options.accountId);
  if (!listener) throw new Error("WhatsApp is not connected (no active web listener)");
  const result = await listener.sendPoll(to, poll);
  return { messageId: result?.messageId || "unknown", toJid: to };
}

export async function handleWhatsAppAction(params, cfg) {
  if (params.action === "send" || params.text || params.body) {
    const to = params.to || params.target;
    const text = params.text || params.body || "";
    return await sendMessageWhatsApp(to, text, {
      verbose: params.verbose ?? false,
      cfg,
      mediaUrl: params.mediaUrl,
      accountId: params.accountId
    });
  }
  throw new Error(`Unsupported WhatsApp action: ${params.action || "unknown"}`);
}