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

async function generateCoverImage(params: {
  litellmUrl: string;
  litellmKey: string;
  title: string;
  occasion: string;
  friends: string;
  style: string;
  trackIndex: number;
}): Promise<string | undefined> {
  const imagePrompt =
    `Generate a vibrant album cover for a ${params.style} song called "${params.title}", ` +
    `created as an invitation for a ${params.occasion}. ` +
    `Inspired by Amstel beer — warm colours, festive, celebratory atmosphere. ` +
    `Friends invited: ${params.friends}.`;

  const res = await fetch(`${params.litellmUrl}/images/generations`, {
    method: "POST",
    headers: litellmHeaders(params.litellmKey),
    body: JSON.stringify({
      model: "gemini-2.5-flash-image",
      prompt: imagePrompt,
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
    api.registerTool((ctx: OpenClawPluginToolContext) => ({
      name: "suno_generate",
      label: "Generate Song",
      description:
        "Generate personalised song invitations using Suno AI. " +
        "Generates lyrics + progress messages + 2 album covers via LiteLLM, " +
        "submits to Suno (returns 2 tracks ~1 min each). " +
        "Sends cute progress messages + cover images directly to the user during generation. " +
        "Returns MEDIA: lines for each audio track — copy them exactly into your reply.",
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
            console.error(`[suno] sendDirect failed:`, err);
          }
        };

        const inputTitle = params.title?.trim() || params.occasion;

        // Step 1: Generate lyrics (Suno needs these before submission)
        const generatedLyrics = await generateLyrics({
          litellmUrl: litellmLocation,
          litellmKey,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
        });

        // Send immediate acknowledgment
        await sendDirect(`🎶 On it! Cooking up your ${params.style} invitation for ${params.occasion}...`);

        // Step 2: Start covers + progress messages in parallel with Suno submission
        const cover0Promise = generateCoverImage({
          litellmUrl: litellmLocation,
          litellmKey,
          title: `${inputTitle} (1)`,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
          trackIndex: 0,
        }).catch((err) => { console.error("[suno] Cover 0 failed:", err); return undefined; });

        const cover1Promise = generateCoverImage({
          litellmUrl: litellmLocation,
          litellmKey,
          title: `${inputTitle} (2)`,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
          trackIndex: 1,
        }).catch((err) => { console.error("[suno] Cover 1 failed:", err); return undefined; });

        const progressPromise = generateProgressMessages({
          litellmUrl: litellmLocation,
          litellmKey,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
        });

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
        const coverFilePaths = [await cover0Promise, await cover1Promise] as const;
        console.log(`[suno] Covers: ${JSON.stringify(coverFilePaths)}`);

        const results: string[] = [];
        const details: Array<Record<string, unknown>> = [];

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (!track) continue;

          const audioUrl = track.sourceAudioUrl ?? track.audioUrl ?? track.streamAudioUrl ?? "";
          const trackTitle = track.title ?? `${inputTitle} (${i + 1})`;

          // Send cover directly first, then audio arrives via MEDIA: line — they land together
          const coverFilePath = coverFilePaths[i];
          console.log(`[suno] Track ${i + 1} — audioUrl=${audioUrl} coverFilePath=${coverFilePath}`);
          if (coverFilePath) {
            await sendDirect(`🎨 ${trackTitle}`, coverFilePath);
          }

          results.push(`\n🎵 Track ${i + 1}: "${trackTitle}"`);
          results.push(`MEDIA:${audioUrl}`);

          details.push({ audioUrl, coverFilePath, trackTitle });
        }

        return {
          content: [{ type: "text", text: results.join("\n") }],
          details,
        };
      },
    }));
  },
};
