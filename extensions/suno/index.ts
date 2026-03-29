import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = "https://api.sunoapi.org";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 120 * 1000; // 120 seconds

// Covers are saved here and sent as local files directly via WhatsApp
const COVERS_DIR = path.join(os.homedir(), ".openclaw", "media", "suno-covers");

function litellmHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function generateLyrics(params: {
  litellmUrl: string;
  litellmKey: string;
  occasion: string;
  friends: string;
  style: string;
}): Promise<string> {
  const prompt =
    `Generate lyrics for a song invitation to a ${params.occasion}. ` +
    `The music style is ${params.style} — use this to inform the mood and energy, but DO NOT mention the genre or style name anywhere in the lyrics. ` +
    `The invited friends are: ${params.friends}. ` +
    `Make the lyrics witty and personal tailored to the occasion and the friends — mention the friends by name. ` +
    `IMPORTANT: Keep the lyrics extremely short — MAXIMUM 60 words total. This is critical. ` +
    `Structure: a short verse, a short catchy chorus, done. ` +
    `End the lyrics with the Suno metatag [end] on its own line. ` +
    `Return ONLY the lyrics text, no explanations.`;

  const res = await fetch(`${params.litellmUrl}/chat/completions`, {
    method: "POST",
    headers: litellmHeaders(params.litellmKey),
    body: JSON.stringify({
      model: "gpt-5-mini",
      temperature: 0.7,
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Lyrics generation failed (${res.status}): ${text}`);
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const lyrics = data.choices?.[0]?.message?.content?.trim();
  if (!lyrics) {
    console.error("[suno] LiteLLM lyrics response:", text.slice(0, 500));
    throw new Error("LiteLLM returned no lyrics content.");
  }
  // Ensure [end] tag is present for Suno to stop the song
  return lyrics.includes("[end]") ? lyrics : `${lyrics}\n[end]`;
}

async function generateProgressMessages(params: {
  litellmUrl: string;
  litellmKey: string;
  occasion: string;
  friends: string;
  style: string;
}): Promise<string[]> {
  const prompt =
    `Generate 6 short, fun, whimsical progress messages to send while creating a ${params.style} song invitation for a ${params.occasion}. ` +
    `The friends being invited are: ${params.friends}. ` +
    `Make them playful and personalized — reference the occasion or the friends by name where it fits naturally. ` +
    `Each message should be 1 sentence with a relevant emoji. Examples of the vibe: "🎻 Tuning my violin for Maria...", "🍺 Cracking open an Amstel for inspiration...". ` +
    `Return ONLY a JSON array of 6 strings, no other text.`;

  try {
    const res = await fetch(`${params.litellmUrl}/chat/completions`, {
      method: "POST",
      headers: litellmHeaders(params.litellmKey),
      body: JSON.stringify({
        model: "gpt-5-mini",
        temperature: 0.9,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    // Extract JSON array from the response (model may wrap it in markdown)
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }
}

async function generateImagePrompt(params: {
  litellmUrl: string;
  litellmKey: string;
  occasion: string;
  friends: string;
  style: string;
  title: string;
}): Promise<string> {
  const metaPrompt =
    `Write a detailed image generation prompt for an album cover. ` +
    `The mood should be inspired by a ${params.style} ${params.occasion} — use that only to set the atmosphere and visual energy, not as literal content. ` +
    `Requirements: ` +
    `- Amstel beer is the hero of the image: prominent Amstel bottles, cans or glasses with the red star logo clearly visible, styled beautifully ` +
    `- The aesthetic should feel like the ${params.style} genre — let that inform lighting, colour palette, and composition ` +
    `- Celebratory, warm, inviting energy ` +
    `- High quality, photorealistic or painterly ` +
    `- Absolutely NO text, words, letters, names, numbers, or placeholders anywhere in the image ` +
    `Return ONLY the image generation prompt, no explanation.`;

  try {
    const res = await fetch(`${params.litellmUrl}/chat/completions`, {
      method: "POST",
      headers: litellmHeaders(params.litellmKey),
      body: JSON.stringify({
        model: "gpt-5-mini",
        temperature: 0.8,
        max_tokens: 250,
        messages: [{ role: "user", content: metaPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = JSON.parse(await res.text()) as { choices?: Array<{ message?: { content?: string } }> };
    const prompt = data.choices?.[0]?.message?.content?.trim();
    if (prompt) return prompt;
  } catch (err) {
    console.error("[suno] Image prompt generation failed, using fallback:", err);
  }
  return (
    `Amstel beer bottles and glasses with the red star logo as the hero, ` +
    `${params.style} music aesthetic, warm amber and gold tones, celebratory atmosphere, ` +
    `beautifully lit, photorealistic, no text or words anywhere in the image`
  );
}

async function generateCoverImage(params: {
  litellmUrl: string;
  litellmKey: string;
  imagePrompt: string;
  trackIndex: number;
}): Promise<string | undefined> {
  const res = await fetch(`${params.litellmUrl}/images/generations`, {
    method: "POST",
    headers: litellmHeaders(params.litellmKey),
    body: JSON.stringify({
      model: "gemini-2.5-flash-image",
      prompt: params.imagePrompt,
      response_format: "b64_json",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cover image generation failed (${res.status}): ${text}`);
  }
  const data = JSON.parse(text) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error(`Cover image: no b64_json in response: ${text.slice(0, 200)}`);

  await fs.mkdir(COVERS_DIR, { recursive: true });
  const filename = `cover-${Date.now()}-${params.trackIndex}.png`;
  const filePath = path.join(COVERS_DIR, filename);
  await fs.writeFile(filePath, Buffer.from(b64, "base64"));
  console.log("created image saved to ",COVERS_DIR)
  return filePath;
}

/** Extract the WhatsApp recipient JID from a per-channel-peer session key.
 *  Format: agent:<agentId>:whatsapp:dm:<peerId>
 */
function extractWhatsAppTo(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const lower = sessionKey.toLowerCase();
  // Find ":direct:" segment and return everything after it
  const dmMarker = ":direct:";
  const dmIdx = lower.indexOf(dmMarker);
  if (dmIdx === -1) return undefined;
  return sessionKey.slice(dmIdx + dmMarker.length);
}

export default {
  id: "suno",
  name: "Suno",
  description: "Generate songs using the Suno API",
  configSchema: {
    type: "object",
    properties: {
      apiKey: { type: "string" },
    },
  },
  register(api: OpenClawPluginApi) {
    // Track WhatsApp recipients where suno just finished — suppress the agent's next reply
    const suppressNextReply = new Set<string>();

    api.registerHook("after_tool_call", (event, ctx) => {
      if (event.toolName !== "suno_generate") return;
      const recipient = extractWhatsAppTo(ctx.sessionKey);
      if (recipient) {
        suppressNextReply.add(recipient);
        console.log(`[suno] Will suppress next agent reply to ${recipient}`);
      }
    });

    api.registerHook("message_sending", (event) => {
      if (suppressNextReply.has(event.to)) {
        suppressNextReply.delete(event.to);
        console.log(`[suno] Suppressed agent reply to ${event.to}`);
        return { cancel: true };
      }
    });

    api.registerTool((ctx: OpenClawPluginToolContext) => ({
      name: "suno_generate",
      label: "Generate Song",
      description:
        "Generate personalised song invitations using Suno AI. " +
        "Sends covers, audio tracks, and a closing message directly to the user via WhatsApp. " +
        "After this tool completes, send NO reply — not even a short one. Everything is already handled.",
      parameters: {
        type: "object",
        properties: {
          occasion: {
            type: "string",
            description: "The occasion for the song invitation (e.g. birthday, drinks, barbecue)",
          },
          friends: {
            type: "string",
            description: "Names of the friends being invited and a short description of each",
          },
          style: {
            type: "string",
            description: "Music style/genre e.g. 'pop', 'jazz', 'opera'",
          },
          title: {
            type: "string",
            description: "Song title (optional — defaults to the occasion)",
          },
        },
        required: ["occasion", "friends", "style"],
      },

      async execute(_id: string, rawParams: Record<string, unknown>) {
        const params = {
          occasion: rawParams.occasion as string,
          friends: rawParams.friends as string,
          style: rawParams.style as string,
          title: rawParams.title as string | undefined,
        };

        const sunoKey =
          process.env.SUNO_KEY ?? (api.pluginConfig as Record<string, unknown>)?.apiKey;
        if (!sunoKey) throw new Error("Suno API key not configured. Set SUNO_KEY.");
        const litellmKey = process.env.LITELLM_KEY;
        if (!litellmKey) throw new Error("LiteLLM key not configured. Set LITELLM_KEY.");
        const litellmLocation = process.env.LITELLM_LOCATION?.replace(/\/$/, "");
        if (!litellmLocation) throw new Error("LiteLLM URL not configured. Set LITELLM_LOCATION.");

        // Helper: send a WhatsApp message directly mid-generation
        const whatsappTo = extractWhatsAppTo(ctx.sessionKey);
        console.log(`[suno] sessionKey=${ctx.sessionKey} whatsappTo=${whatsappTo}`);
        const sendDirect = async (message: string, mediaUrl?: string) => {
          if (!whatsappTo) {
            console.warn(`[suno] sendDirect skipped — whatsappTo is undefined`);
            return;
          }
          try {
            await api.runtime.channel.whatsapp.sendMessageWhatsApp(
              whatsappTo,
              message,
              { verbose: false, ...(mediaUrl ? { mediaUrl } : {}) },
            );
            console.log(`[suno] sendDirect ok — "${message.slice(0, 40)}"${mediaUrl ? ` + media: ${mediaUrl}` : ""}`);
          } catch (err) {
            console.log(`[suno] sendDirect failed (not surfaced to user):`, err);
          }
        };

        const inputTitle = params.title?.trim() || params.occasion;

        // Step 1: Send ack immediately, then kick off all async work in parallel
        await sendDirect(`🎶 On it! Cooking up your ${params.style} invitation for ${params.occasion}...`);

        const lyricsPromise = generateLyrics({
          litellmUrl: litellmLocation,
          litellmKey,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
        });

        const imagePromptPromise = generateImagePrompt({
          litellmUrl: litellmLocation,
          litellmKey,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
          title: inputTitle,
        });

        const progressPromise = generateProgressMessages({
          litellmUrl: litellmLocation,
          litellmKey,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
        });

        // Start covers as soon as the image prompt resolves — don't wait for lyrics/Suno
        const coversPromise = imagePromptPromise.then((imagePrompt) =>
          Promise.all([
            generateCoverImage({ litellmUrl: litellmLocation, litellmKey, imagePrompt, trackIndex: 0 })
              .catch((err) => { console.error("[suno] Cover 0 failed:", err); return undefined; }),
            generateCoverImage({ litellmUrl: litellmLocation, litellmKey, imagePrompt, trackIndex: 1 })
              .catch((err) => { console.error("[suno] Cover 1 failed:", err); return undefined; }),
          ])
        );

        const generatedLyrics = await lyricsPromise;

        // Submit to Suno
        const sunoHeaders = {
          Authorization: `Bearer ${sunoKey}`,
          "Content-Type": "application/json",
        };

        const genRes = await fetch(`${BASE_URL}/api/v1/generate`, {
          method: "POST",
          headers: sunoHeaders,
          body: JSON.stringify({
            prompt: generatedLyrics,
            customMode: true,
            instrumental: false,
            model: "V4",
            style: params.style,
            title: inputTitle,
            callBackUrl: "https://www.google.com",
          }),
        });
        const genText = await genRes.text();
        if (!genRes.ok) throw new Error(`Suno generate failed (${genRes.status}): ${genText}`);
        const genData = JSON.parse(genText) as { data?: { taskId?: string } };
        const taskId = genData?.data?.taskId;
        if (!taskId) throw new Error(`Suno did not return a taskId: ${genText}`);

        // Progress messages should be ready by now (generated concurrently with Suno submit)
        const resolvedProgress = await progressPromise;
        const messages: string[] = resolvedProgress.length > 0
          ? resolvedProgress
          : ["🎻 Composing your invitation...", "🍺 Adding a touch of Amstel magic...", "🎵 Almost there..."];
        console.log(`[suno] Progress messages: ${JSON.stringify(messages)}`);

        // Step 3: Poll Suno — covers generating concurrently, wait for SUCCESS
        type SunoTrack = {
          id?: string;
          audioUrl?: string;
          sourceAudioUrl?: string;
          streamAudioUrl?: string;
          title?: string;
        };
        type PollResponse = {
          data?: {
            status?: string;
            response?: { sunoData?: SunoTrack[] };
          };
        };

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let tracks: SunoTrack[] = [];
        let pollCount = 0;
        let msgIdx = 0;

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          pollCount++;

          // Send a progress message every 2 polls (~10 seconds)
          if (pollCount % 2 === 1 && msgIdx < messages.length) {
            const msg = messages[msgIdx++];
            if (msg) await sendDirect(msg);
          }

          const pollRes = await fetch(
            `${BASE_URL}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
            { headers: sunoHeaders },
          );
          const pollText = await pollRes.text();
          if (!pollRes.ok) throw new Error(`Suno poll failed (${pollRes.status}): ${pollText}`);

          const poll = JSON.parse(pollText) as PollResponse;
          const status = poll.data?.status;
          const sunoData = poll.data?.response?.sunoData ?? [];
          console.log(`[suno] poll ${pollCount}: status=${status} tracks=${sunoData.length}`);

          if (
            status === "CREATE_TASK_FAILED" ||
            status === "GENERATE_AUDIO_FAILED" ||
            status === "SENSITIVE_WORD_ERROR"
          ) {
            throw new Error(`Suno generation failed with status: ${status}`);
          }

          // Wait for SUCCESS (both tracks done) — FIRST_SUCCESS only has track 1
          if (
            status === "SUCCESS" &&
            sunoData.length > 0 &&
            sunoData[0] &&
            (sunoData[0].audioUrl || sunoData[0].sourceAudioUrl || sunoData[0].streamAudioUrl)
          ) {
            tracks = sunoData;
            break;
          }
        }

        if (tracks.length === 0) {
          throw new Error("Suno generation timed out — try again.");
        }

        // Step 4: Covers should be ready by now (were generating during ~60s poll)
        const coverFilePaths = await coversPromise;
        console.log(`[suno] Covers: ${JSON.stringify(coverFilePaths)}`);

        const details: Array<Record<string, unknown>> = [];

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (!track) continue;

          const trackTitle = track.title ?? `${inputTitle} (${i + 1})`;
          const coverFilePath = coverFilePaths[i];

          // Log all URL variants to help diagnose reachability issues
          console.log(`[suno] Track ${i + 1} URLs — source=${track.sourceAudioUrl} audio=${track.audioUrl} stream=${track.streamAudioUrl}`);

          // Resolve relative URLs against the Suno base URL, discard non-HTTP ones
          const resolveAudioUrl = (raw: string): string => {
            if (/^https?:\/\//i.test(raw)) return raw;
            const clean = raw.replace(/\\/g, "/");
            return `${BASE_URL}${clean.startsWith("/") ? "" : "/"}${clean}`;
          };

          // Pick the first URL that is reachable (HEAD request)
          const candidates = [track.sourceAudioUrl, track.audioUrl, track.streamAudioUrl]
            .filter(Boolean)
            .map((u) => resolveAudioUrl(u!));
          let audioUrl = "";
          for (const url of candidates) {
            try {
              const probe = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
              if (probe.ok) { audioUrl = url; break; }
              console.warn(`[suno] URL not ok (${probe.status}): ${url}`);
            } catch (err) {
              console.warn(`[suno] URL unreachable: ${url} — ${err}`);
            }
          }
          if (!audioUrl) {
            console.log(`[suno] No reachable audio URL for track ${i + 1}, skipping audio send`);
          }

          console.log(`[suno] Track ${i + 1} — using audioUrl=${audioUrl} coverFilePath=${coverFilePath}`);

          // Send cover then audio directly — both arrive together per track
          if (coverFilePath) {
            const coverExists = await fs.access(coverFilePath).then(() => true).catch(() => false);
            if (coverExists) {
              await sendDirect(`🎨 ${trackTitle}`, coverFilePath);
            } else {
              console.log(`[suno] Cover file not found, skipping: ${coverFilePath}`);
            }
          }
          if (audioUrl) {
            await sendDirect("", audioUrl);
          }

          details.push({ audioUrl, coverFilePath, trackTitle });
        }

        await sendDirect("Hope you enjoy your songs! 🍺🎶");

        return {
          content: [{ type: "text", text: `✅ Done — tracks, covers, and closing message all sent directly. Do NOT send any reply message.` }],
          details,
        };
      },
    }));
  },
};
