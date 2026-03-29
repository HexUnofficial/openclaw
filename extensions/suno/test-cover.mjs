#!/usr/bin/env node
/**
 * Quick standalone test for cover image generation.
 * Usage: node test-cover.mjs
 * Requires: LITELLM_KEY and LITELLM_LOCATION env vars
 */
import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";




const litellmKey = process.env.LITELLM_KEY;
const litellmUrl = process.env.LITELLM_LOCATION?.replace(/\/$/, "");

if (!litellmKey || !litellmUrl) {
  console.error("Missing LITELLM_KEY or LITELLM_LOCATION env vars");
  process.exit(1);
}

const imagePrompt =
  `Generate a vibrant album cover for a pop song called "Test Drinks (1)", ` +
  `created as an invitation for a birthday drinks. ` +
  `Inspired by Amstel beer — warm colours, festive, celebratory atmosphere. ` +
  `Friends invited: Alice, Bob.`;

console.log("Sending image generation request...");
console.log("Prompt:", imagePrompt);
console.log("URL:", `${litellmUrl}/images/generations`);

const res = await fetch(`${litellmUrl}/images/generations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${litellmKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gemini-2.5-flash-image",
    prompt: imagePrompt,
    response_format: "b64_json",
  }),
});

const text = await res.text();
console.log(`Response status: ${res.status}`);

if (!res.ok) {
  console.error("FAILED:", text);
  process.exit(1);
}

const data = JSON.parse(text);
const b64 = data?.data?.[0]?.b64_json;

if (!b64) {
  console.error("No b64_json in response:", text.slice(0, 500));
  process.exit(1);
}

const outDir = path.join(os.tmpdir(), "suno-covers");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `test-cover-${Date.now()}.png`);
await fs.writeFile(outPath, Buffer.from(b64, "base64"));

console.log("SUCCESS! Cover saved to:", outPath);
