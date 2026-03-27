import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = "https://api.sunoapi.org";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 120 * 1000; // 120 seconds

// Covers are saved here and served via the plugin HTTP route
const COVERS_DIR = path.join(os.tmpdir(), "suno-covers");

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
    `Generate lyrics for a ${params.style} song invitation for a ${params.occasion}. ` +
    `The invited friends are: ${params.friends}. ` +
    `Make the lyrics fun, celebratory, and personal — mention the friends by name and include details about them. ` +
    `The lyrics will be fed directly into Suno for music generation.`;

  const res = await fetch(`${params.litellmUrl}/chat/completions`, {
    method: "POST",
    headers: litellmHeaders(params.litellmKey),
    body: JSON.stringify({
      model: "gpt-5-mini",
      temperature: 0.2,
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Lyrics generation failed (${res.status}): ${text}`);
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const lyrics = data.choices?.[0]?.message?.content?.trim();
  if (!lyrics) throw new Error("LiteLLM returned no lyrics content.");
  return lyrics;
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

  try {
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
      console.warn(`Cover image generation failed (${res.status}): ${text}`);
      return undefined;
    }
    const data = JSON.parse(text) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return undefined;

    await fs.mkdir(COVERS_DIR, { recursive: true });
    const filename = `cover-${Date.now()}-${params.trackIndex}.png`;
    const filePath = path.join(COVERS_DIR, filename);
    await fs.writeFile(filePath, Buffer.from(b64, "base64"));
    return filename;
  } catch (err) {
    console.warn("Cover image generation error:", err);
    return undefined;
  }
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
    // Serve generated cover images without auth (plugin routes bypass gateway auth)
    const gatewayPort: number =
      (api.config as Record<string, unknown>).gateway &&
      typeof ((api.config as Record<string, unknown>).gateway as Record<string, unknown>).port === "number"
        ? ((api.config as Record<string, unknown>).gateway as Record<string, unknown>).port as number
        : 18789;

    api.registerHttpRoute({
      path: "/suno-cover",
      handler: async (req, res) => {
        const filename = new URL(req.url ?? "/", "http://localhost").searchParams.get("file");
        if (!filename || filename.includes("/") || filename.includes("..")) {
          res.statusCode = 400;
          res.end("Bad Request");
          return;
        }
        const filePath = path.join(COVERS_DIR, filename);
        try {
          const buf = await fs.readFile(filePath);
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Content-Length", buf.length);
          res.end(buf);
        } catch {
          res.statusCode = 404;
          res.end("Not Found");
        }
      },
    });

    api.registerTool({
      name: "suno_generate",
      label: "Generate Song",
      description:
        "Generate personalised song invitations using Suno AI. " +
        "Generates lyrics via LiteLLM, submits to Suno (returns 2 tracks), " +
        "and creates 2 custom album covers via LiteLLM image generation. " +
        "Returns MEDIA: lines for each audio + cover — copy them exactly into your reply.",
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

      async execute(_id, params) {
        const sunoKey =
          process.env.SUNO_KEY ?? (api.pluginConfig as Record<string, unknown>)?.apiKey;
        if (!sunoKey) {
          throw new Error("Suno API key not configured. Set SUNO_KEY in your .env file.");
        }
        const litellmKey = process.env.LITELLM_KEY;
        if (!litellmKey) {
          throw new Error("LiteLLM API key not configured. Set LITELLM_KEY in your .env file.");
        }
        const litellmLocation = process.env.LITELLM_LOCATION?.replace(/\/$/, "");
        if (!litellmLocation) {
          throw new Error(
            "LiteLLM base URL not configured. Set LITELLM_LOCATION in your .env file.",
          );
        }

        const inputTitle = (params.title as string | undefined)?.trim() || params.occasion;

        // Step 1: Generate lyrics via LiteLLM
        const generatedLyrics = await generateLyrics({
          litellmUrl: litellmLocation,
          litellmKey,
          occasion: params.occasion,
          friends: params.friends,
          style: params.style,
        });

        // Step 2: Submit to Suno
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
        if (!genRes.ok) {
          throw new Error(`Suno generate failed (${genRes.status}): ${genText}`);
        }
        const genData = JSON.parse(genText) as { data?: { taskId?: string } };
        const taskId = genData?.data?.taskId;
        if (!taskId) {
          throw new Error(`Suno did not return a taskId: ${genText}`);
        }

        // Step 3: Poll until SUCCESS — Suno returns 2 tracks
        type SunoTrack = {
          id?: string;
          audioUrl?: string;
          sourceAudioUrl?: string;
          streamAudioUrl?: string;
          imageUrl?: string;
          sourceImageUrl?: string;
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

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          const pollRes = await fetch(
            `${BASE_URL}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
            { headers: sunoHeaders },
          );
          const pollText = await pollRes.text();
          if (!pollRes.ok) {
            throw new Error(`Suno poll failed (${pollRes.status}): ${pollText}`);
          }

          const poll = JSON.parse(pollText) as PollResponse;
          const status = poll.data?.status;
          const sunoData = poll.data?.response?.sunoData ?? [];

          if (
            status === "CREATE_TASK_FAILED" ||
            status === "GENERATE_AUDIO_FAILED" ||
            status === "SENSITIVE_WORD_ERROR"
          ) {
            throw new Error(`Suno generation failed with status: ${status}`);
          }

          if (
            (status === "SUCCESS" || status === "FIRST_SUCCESS") &&
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

        // Step 4: For each track, generate a custom album cover + download audio
        const results: string[] = [];
        const details: Array<Record<string, unknown>> = [];

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (!track) continue;

          const audioUrl =
            track.sourceAudioUrl ?? track.audioUrl ?? track.streamAudioUrl ?? "";
          const trackTitle = track.title ?? `${inputTitle} (${i + 1})`;

          results.push(`\n🎵 Track ${i + 1}: "${trackTitle}"`);

          // Download audio locally
          let localPath: string | undefined;
          try {
            const filename = `suno-${track.id ?? Date.now()}-${i}.mp3`;
            localPath = path.join(os.tmpdir(), filename);
            const audioResp = await fetch(audioUrl);
            if (audioResp.ok) {
              await fs.writeFile(localPath, Buffer.from(await audioResp.arrayBuffer()));
            }
          } catch {
            localPath = undefined;
          }
          if (localPath) results.push(`Local audio: ${localPath}`);
          results.push(`MEDIA:${audioUrl}`);

          // Generate custom album cover
          const coverFilename = await generateCoverImage({
            litellmUrl: litellmLocation,
            litellmKey,
            title: trackTitle,
            occasion: params.occasion,
            friends: params.friends,
            style: params.style,
            trackIndex: i,
          });
          if (coverFilename) {
            const coverUrl = `http://localhost:${gatewayPort}/suno-cover?file=${encodeURIComponent(coverFilename)}`;
            results.push(`MEDIA:${coverUrl}`);
          }

          details.push({ audioUrl, localPath, coverFilename, trackTitle });
        }

        return {
          content: [{ type: "text", text: results.join("\n") }],
          details,
        };
      },
    });
  },
};
