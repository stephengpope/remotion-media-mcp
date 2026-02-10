#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import {
  getAirtableConfig,
  createAirtableRecord,
  listAirtableRecords,
  getAirtableRecordByAid,
  uploadAttachmentToAirtable,
  detectFileType,
  getMimeType,
  type AirtableConfig,
} from "./airtable.js";

const execAsync = promisify(exec);

const API_BASE = "https://api.kie.ai";

// Get API key from environment
function getApiKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    throw new Error("KIE_API_KEY environment variable is required");
  }
  return key;
}

// Poll for task completion
async function pollTaskStatus(
  taskId: string,
  apiKey: string,
  maxAttempts = 120,
  intervalMs = 5000
): Promise<{ success: boolean; data?: any; error?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `${API_BASE}/api/v1/jobs/recordInfo?taskId=${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const result = await response.json();

    if (result.code !== 200) {
      return { success: false, error: `API error: ${result.msg}` };
    }

    const state = result.data?.state;

    if (state === "success") {
      return { success: true, data: result.data };
    }

    if (state === "fail") {
      return {
        success: false,
        error: result.data?.failMsg || "Task failed",
      };
    }

    // Still waiting, continue polling
    console.error(`[remotion-media-mcp] Task ${taskId} status: ${state}, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { success: false, error: "Task timed out" };
}

// Download file to local path
async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

// Post-generation hook: optionally save to Airtable and copy to assets/
async function postGenerationHook(params: {
  remoteUrl?: string;
  localPath: string;
  filename: string;
  description: string;
  fileType: string;
  sourceTool: string;
  taskId?: string;
}): Promise<{ aid?: string; recordId?: string; assetsPath?: string } | null> {
  try {
    const config = getAirtableConfig();
    if (!config) return null;

    // Determine MIME type
    const mimeType = getMimeType(params.filename);

    // Create Airtable record (use remote URL as attachment if available)
    const record = await createAirtableRecord(config, {
      description: params.description,
      fileUrl: params.remoteUrl,
      filename: params.filename,
      mimeType,
    });

    if (!record) return null;

    const { aid, assetFilename, recordId } = record;

    // If no remote URL, try uploading the local file directly
    if (!params.remoteUrl && params.localPath && fs.existsSync(params.localPath)) {
      await uploadAttachmentToAirtable(config, recordId, params.localPath, params.filename);
    }

    // Copy file to assets/ with AID-prefixed filename from Airtable
    let assetsPath: string | undefined;
    const aidFilename = assetFilename || (aid ? `${aid}-${params.filename}` : null);
    if (aidFilename && fs.existsSync(params.localPath)) {
      const assetsDir = path.resolve(process.cwd(), "public");
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }

      assetsPath = path.join(assetsDir, aidFilename);
      fs.copyFileSync(params.localPath, assetsPath);
      console.error(`[remotion-media-mcp] Asset copied to ${assetsPath}`);
    }

    console.error(`[remotion-media-mcp] Airtable record created: ${aid} (${recordId})`);
    return { aid, recordId, assetsPath };
  } catch (error) {
    console.error(
      `[remotion-media-mcp] postGenerationHook error (non-fatal):`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

// Check for Whisper installation and return the command name
function getWhisperCommand(): { cmd: string; type: "whisper-cpp" | "openai-whisper" } | null {
  // Check for whisper.cpp (Homebrew) - binary is called whisper-cli
  try {
    execSync("which whisper-cli", { stdio: "ignore" });
    return { cmd: "whisper-cli", type: "whisper-cpp" };
  } catch {}

  // Check in Homebrew opt path
  try {
    const brewPath = "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli";
    if (fs.existsSync(brewPath)) {
      return { cmd: brewPath, type: "whisper-cpp" };
    }
  } catch {}

  // Check for OpenAI whisper (Python)
  try {
    execSync("which whisper", { stdio: "ignore" });
    return { cmd: "whisper", type: "openai-whisper" };
  } catch {}

  return null;
}

// Poll for Veo video task completion
async function pollVeoTaskStatus(
  taskId: string,
  apiKey: string,
  maxAttempts = 180,
  intervalMs = 5000
): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `${API_BASE}/api/v1/veo/record-info?taskId=${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const result = await response.json();

    if (result.code !== 200) {
      // Check if still processing
      if (result.code === 400 && result.msg?.includes("processing")) {
        console.error(`[remotion-media-mcp] Video ${taskId} still processing...`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      return { success: false, error: `API error: ${result.msg}` };
    }

    const data = result.data;

    // Check if task completed successfully
    if (data?.successFlag === 1 && data?.response?.resultUrls?.length > 0) {
      return { success: true, videoUrl: data.response.resultUrls[0] };
    }

    // Check for error
    if (data?.errorCode || data?.errorMessage) {
      return { success: false, error: data.errorMessage || `Error code: ${data.errorCode}` };
    }

    // Still processing (successFlag === 0)
    console.error(`[remotion-media-mcp] Video ${taskId} status: processing, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { success: false, error: "Video generation timed out" };
}

// Poll for Suno music task completion
async function pollMusicTaskStatus(
  taskId: string,
  apiKey: string,
  maxAttempts = 180,
  intervalMs = 5000
): Promise<{
  success: boolean;
  audioUrl?: string;
  title?: string;
  duration?: number;
  imageUrl?: string;
  error?: string;
}> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `${API_BASE}/api/v1/generate/record-info?taskId=${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const result = await response.json();

    if (result.code !== 200) {
      return { success: false, error: `API error: ${result.msg}` };
    }

    const data = result.data;
    const status = data?.status;

    // SUCCESS means generation is complete
    if (status === "SUCCESS" && data?.sunoData?.[0]?.audioUrl) {
      const sunoData = data.sunoData[0];
      return {
        success: true,
        audioUrl: sunoData.audioUrl,
        title: sunoData.title,
        duration: sunoData.duration,
        imageUrl: sunoData.imageUrl,
      };
    }

    // Check for error states
    if (status === "FAILED" || status === "ERROR") {
      return {
        success: false,
        error: data?.errorMessage || "Music generation failed",
      };
    }

    // Still processing (PENDING, TEXT_SUCCESS, FIRST_SUCCESS)
    console.error(`[remotion-media-mcp] Music ${taskId} status: ${status}, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { success: false, error: "Music generation timed out" };
}

const server = new McpServer({
  name: "remotion-media-mcp",
  version: "1.0.0",
});

// Tool 1: Generate Image using Nano Banana Pro
server.tool(
  "generate_image",
  "Generate an AI image from a text prompt. Use for: thumbnails, backgrounds, illustrations, product shots, concept art, or any visual asset. Supports multiple aspect ratios (1:1, 16:9, 9:16, etc.) and resolutions up to 4K. Can also use reference images for style guidance. Returns downloaded PNG path in public/ folder.",
  {
    prompt: z.string().describe("Text description of the image to generate"),
    output_name: z.string().describe("Output filename without extension (required)"),
    aspect_ratio: z
      .enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"])
      .optional()
      .describe("Aspect ratio of the generated image. Defaults to 1:1"),
    resolution: z
      .enum(["1K", "2K", "4K"])
      .optional()
      .describe("Resolution of the generated image. Defaults to 1K"),
    image_urls: z
      .array(z.string())
      .optional()
      .describe("Optional reference image URLs (up to 8 images)"),
  },
  async ({ prompt, output_name, aspect_ratio, resolution, image_urls }) => {
    try {
      const apiKey = getApiKey();
      console.error(`[remotion-media-mcp] Starting image generation: "${prompt.substring(0, 50)}..."`);

      // Create task
      const createResponse = await fetch(`${API_BASE}/api/v1/jobs/createTask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "nano-banana-pro",
          input: {
            prompt,
            image_input: image_urls || [],
            aspect_ratio: aspect_ratio || "1:1",
            resolution: resolution || "1K",
            output_format: "png",
          },
        }),
      });

      const createResult = await createResponse.json();

      if (createResult.code !== 200) {
        return {
          content: [{ type: "text" as const, text: `Error creating task: ${createResult.msg}` }],
        };
      }

      const taskId = createResult.data.taskId;
      console.error(`[remotion-media-mcp] Task created: ${taskId}`);

      // Poll for completion
      const pollResult = await pollTaskStatus(taskId, apiKey);

      if (!pollResult.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pollResult.error}` }],
        };
      }

      // Extract image URL from result
      const resultJson = JSON.parse(pollResult.data.resultJson);
      const imageUrl = resultJson.resultUrls?.[0];

      if (!imageUrl) {
        return {
          content: [{ type: "text" as const, text: "Error: No image URL in response" }],
        };
      }

      // Download image
      const filename = output_name || `generated-${Date.now()}`;
      const outputPath = path.resolve(process.cwd(), "public", `${filename}.png`);

      console.error(`[remotion-media-mcp] Downloading image to ${outputPath}...`);
      await downloadFile(imageUrl, outputPath);
      console.error(`[remotion-media-mcp] Image saved successfully!`);

      // Airtable post-generation hook
      const postResult = await postGenerationHook({
        remoteUrl: imageUrl,
        localPath: outputPath,
        filename: `${filename}.png`,
        description: prompt,
        fileType: "image",
        sourceTool: "generate_image",
        taskId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: outputPath,
                relativePath: `public/${filename}.png`,
                taskId,
                imageUrl,
                ...(postResult?.aid && { aid: postResult.aid }),
                ...(postResult?.recordId && { airtableRecordId: postResult.recordId }),
                ...(postResult?.assetsPath && { assetsPath: postResult.assetsPath }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating image: ${message}` }],
      };
    }
  }
);

// Tool 2: Generate Video from Text using Veo 3.1
server.tool(
  "generate_video_from_text",
  "Generate an AI video from a text description. Use for: explainer clips, b-roll footage, animated scenes, product demos, or any video content. Creates ~8 second clips. Choose 'veo3' for quality or 'veo3_fast' for speed. Supports 16:9 (landscape), 9:16 (portrait/mobile). Returns downloaded MP4 path in public/ folder.",
  {
    prompt: z.string().describe("Text description of the video to generate"),
    output_name: z.string().describe("Output filename without extension (required)"),
    model: z
      .enum(["veo3", "veo3_fast"])
      .optional()
      .describe("Model to use. veo3 = Quality, veo3_fast = Fast. Defaults to veo3_fast"),
    aspect_ratio: z
      .enum(["16:9", "9:16", "Auto"])
      .optional()
      .describe("Video aspect ratio. Defaults to 16:9"),
  },
  async ({ prompt, output_name, model, aspect_ratio }) => {
    try {
      const apiKey = getApiKey();
      console.error(`[remotion-media-mcp] Starting text-to-video generation: "${prompt.substring(0, 50)}..."`);

      // Create video generation task
      const createResponse = await fetch(`${API_BASE}/api/v1/veo/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt,
          model: model || "veo3_fast",
          generationType: "TEXT_2_VIDEO",
          aspect_ratio: aspect_ratio || "16:9",
          enableTranslation: true,
        }),
      });

      const createResult = await createResponse.json();
      console.error(`[remotion-media-mcp] API response:`, JSON.stringify(createResult, null, 2));

      if (createResult.code !== 200) {
        return {
          content: [{ type: "text" as const, text: `Error creating video task: ${createResult.msg || JSON.stringify(createResult)}` }],
        };
      }

      const taskId = createResult.data.taskId;
      console.error(`[remotion-media-mcp] Video task created: ${taskId}`);

      // Poll for completion
      const pollResult = await pollVeoTaskStatus(taskId, apiKey);

      if (!pollResult.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pollResult.error}` }],
        };
      }

      // Download video
      const filename = output_name || `generated-${Date.now()}`;
      const outputPath = path.resolve(process.cwd(), "public", `${filename}.mp4`);

      console.error(`[remotion-media-mcp] Downloading video to ${outputPath}...`);
      await downloadFile(pollResult.videoUrl!, outputPath);
      console.error(`[remotion-media-mcp] Video saved successfully!`);

      // Airtable post-generation hook
      const postResult = await postGenerationHook({
        remoteUrl: pollResult.videoUrl,
        localPath: outputPath,
        filename: `${filename}.mp4`,
        description: prompt,
        fileType: "video",
        sourceTool: "generate_video_from_text",
        taskId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: outputPath,
                relativePath: `public/${filename}.mp4`,
                taskId,
                videoUrl: pollResult.videoUrl,
                ...(postResult?.aid && { aid: postResult.aid }),
                ...(postResult?.recordId && { airtableRecordId: postResult.recordId }),
                ...(postResult?.assetsPath && { assetsPath: postResult.assetsPath }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating video: ${message}` }],
      };
    }
  }
);

// Tool 3: Generate Video from Image using Veo 3.1
server.tool(
  "generate_video_from_image",
  "Animate a still image into video, or create a video transition between two images. Use for: bringing photos to life, creating parallax effects, morphing between scenes, or animating illustrations. Pass 1 image URL to animate it, or 2 image URLs to transition from first to last frame. Returns downloaded MP4 path in public/ folder.",
  {
    prompt: z.string().describe("Text description of how the video should animate/transition"),
    image_urls: z
      .array(z.string())
      .min(1)
      .max(2)
      .describe("1-2 image URLs. 1 image = animate it. 2 images = transition from first to last frame."),
    output_name: z.string().describe("Output filename without extension (required)"),
    model: z
      .enum(["veo3", "veo3_fast"])
      .optional()
      .describe("Model to use. veo3 = Quality, veo3_fast = Fast. Defaults to veo3_fast"),
    aspect_ratio: z
      .enum(["16:9", "9:16", "Auto"])
      .optional()
      .describe("Video aspect ratio. Defaults to 16:9"),
  },
  async ({ prompt, image_urls, output_name, model, aspect_ratio }) => {
    try {
      const apiKey = getApiKey();
      console.error(`[remotion-media-mcp] Starting image-to-video generation with ${image_urls.length} image(s)...`);

      // Determine generation type based on number of images
      const generationType = image_urls.length === 1 ? "IMAGE_2_VIDEO" : "FIRST_AND_LAST_FRAMES_2_VIDEO";

      // Create video generation task
      const createResponse = await fetch(`${API_BASE}/api/v1/veo/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt,
          imageUrls: image_urls,
          model: model || "veo3_fast",
          generationType,
          aspect_ratio: aspect_ratio || "16:9",
          enableTranslation: true,
        }),
      });

      const createResult = await createResponse.json();
      console.error(`[remotion-media-mcp] API response:`, JSON.stringify(createResult, null, 2));

      if (createResult.code !== 200) {
        return {
          content: [{ type: "text" as const, text: `Error creating video task: ${createResult.msg || JSON.stringify(createResult)}` }],
        };
      }

      const taskId = createResult.data.taskId;
      console.error(`[remotion-media-mcp] Video task created: ${taskId}`);

      // Poll for completion
      const pollResult = await pollVeoTaskStatus(taskId, apiKey);

      if (!pollResult.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pollResult.error}` }],
        };
      }

      // Download video
      const filename = output_name || `generated-${Date.now()}`;
      const outputPath = path.resolve(process.cwd(), "public", `${filename}.mp4`);

      console.error(`[remotion-media-mcp] Downloading video to ${outputPath}...`);
      await downloadFile(pollResult.videoUrl!, outputPath);
      console.error(`[remotion-media-mcp] Video saved successfully!`);

      // Airtable post-generation hook
      const postResult = await postGenerationHook({
        remoteUrl: pollResult.videoUrl,
        localPath: outputPath,
        filename: `${filename}.mp4`,
        description: prompt,
        fileType: "video",
        sourceTool: "generate_video_from_image",
        taskId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: outputPath,
                relativePath: `public/${filename}.mp4`,
                taskId,
                videoUrl: pollResult.videoUrl,
                ...(postResult?.aid && { aid: postResult.aid }),
                ...(postResult?.recordId && { airtableRecordId: postResult.recordId }),
                ...(postResult?.assetsPath && { assetsPath: postResult.assetsPath }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating video: ${message}` }],
      };
    }
  }
);

// Tool 4: Generate Sound Effect using ElevenLabs SFX V2
server.tool(
  "generate_sound_effect",
  "Generate a custom sound effect from a text description. Use for: whooshes, impacts, ambient sounds, UI sounds, nature sounds, mechanical noises, or any audio effect. Duration 0.5-22 seconds (auto if not specified). Supports seamless looping for background audio. Returns downloaded MP3 path in public/ folder.",
  {
    prompt: z
      .string()
      .max(450)
      .describe("Description of the sound effect to generate (max 450 chars)"),
    output_name: z.string().describe("Output filename without extension (required)"),
    duration_seconds: z
      .number()
      .min(0.5)
      .max(22)
      .optional()
      .describe("Duration in seconds (0.5-22). If omitted, API auto-determines optimal length"),
    loop: z
      .boolean()
      .optional()
      .describe("Generate a seamless looping sound effect. Defaults to false"),
  },
  async ({ prompt, output_name, duration_seconds, loop }) => {
    try {
      const apiKey = getApiKey();
      console.error(`[remotion-media-mcp] Starting sound effect generation: "${prompt.substring(0, 50)}..."`);

      // Build input for the sound effect model
      const input: Record<string, any> = {
        text: prompt,
        output_format: "mp3_44100_128",
        prompt_influence: 0.3,
      };

      if (duration_seconds !== undefined) {
        input.duration_seconds = duration_seconds;
      }

      if (loop === true) {
        input.loop = true;
      }

      // Create sound effect task using jobs/createTask with elevenlabs/sound-effect-v2 model
      const createResponse = await fetch(`${API_BASE}/api/v1/jobs/createTask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "elevenlabs/sound-effect-v2",
          input,
        }),
      });

      const createResult = await createResponse.json();
      console.error(`[remotion-media-mcp] API response:`, JSON.stringify(createResult, null, 2));

      if (createResult.code !== 200) {
        return {
          content: [{ type: "text" as const, text: `Error creating sound effect task: ${createResult.msg || JSON.stringify(createResult)}` }],
        };
      }

      const taskId = createResult.data?.taskId;
      console.error(`[remotion-media-mcp] Sound effect task created: ${taskId}`);

      // Poll for completion using standard polling
      const pollResult = await pollTaskStatus(taskId, apiKey);

      if (!pollResult.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pollResult.error}` }],
        };
      }

      // Extract audio URL from result
      const resultJson = JSON.parse(pollResult.data.resultJson);
      const audioUrl = resultJson.resultUrls?.[0] || resultJson.audio_url || resultJson.audioUrl;

      if (!audioUrl) {
        console.error(`[remotion-media-mcp] Result JSON:`, JSON.stringify(resultJson, null, 2));
        return {
          content: [{ type: "text" as const, text: "Error: No audio URL in response" }],
        };
      }

      // Download audio
      const filename = output_name || `sfx-${Date.now()}`;
      const outputPath = path.resolve(process.cwd(), "public", `${filename}.mp3`);

      console.error(`[remotion-media-mcp] Downloading sound effect to ${outputPath}...`);
      await downloadFile(audioUrl, outputPath);
      console.error(`[remotion-media-mcp] Sound effect saved successfully!`);

      // Airtable post-generation hook
      const postResult = await postGenerationHook({
        remoteUrl: audioUrl,
        localPath: outputPath,
        filename: `${filename}.mp3`,
        description: prompt,
        fileType: "audio",
        sourceTool: "generate_sound_effect",
        taskId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: outputPath,
                relativePath: `public/${filename}.mp3`,
                taskId,
                audioUrl,
                ...(postResult?.aid && { aid: postResult.aid }),
                ...(postResult?.recordId && { airtableRecordId: postResult.recordId }),
                ...(postResult?.assetsPath && { assetsPath: postResult.assetsPath }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating sound effect: ${message}` }],
      };
    }
  }
);

// Tool 5: Generate Music using Suno
server.tool(
  "generate_music",
  "Generate original AI music from a description. Use for: background music, jingles, intros/outros, mood pieces, or full songs with vocals. Describe the genre, mood, instruments, tempo, or style. Set instrumental=true for no vocals. Uses Suno V5 for highest quality. Returns downloaded MP3 path in public/ folder.",
  {
    prompt: z
      .string()
      .max(500)
      .describe("Description of the music to generate (max 500 chars)"),
    output_name: z.string().describe("Output filename without extension (required)"),
    instrumental: z
      .boolean()
      .optional()
      .describe("Generate instrumental only (no vocals). Defaults to false"),
    model: z
      .enum(["V3_5", "V4", "V4_5", "V4_5PLUS", "V5"])
      .optional()
      .describe("Suno model version. V5 = latest/best quality. Defaults to V5"),
  },
  async ({ prompt, output_name, instrumental, model }) => {
    try {
      const apiKey = getApiKey();
      console.error(`[remotion-media-mcp] Starting music generation: "${prompt.substring(0, 50)}..."`);

      // Create music generation task
      // Note: callBackUrl is required by the API but we use polling instead
      const createResponse = await fetch(`${API_BASE}/api/v1/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt,
          customMode: false,
          instrumental: instrumental === true,
          model: model || "V5",
          callBackUrl: "https://example.com/callback", // Required by API, but we poll for results
        }),
      });

      const createResult = await createResponse.json();
      console.error(`[remotion-media-mcp] API response:`, JSON.stringify(createResult, null, 2));

      if (createResult.code !== 200) {
        return {
          content: [{ type: "text" as const, text: `Error creating music task: ${createResult.msg || JSON.stringify(createResult)}` }],
        };
      }

      const taskId = createResult.data?.taskId;
      console.error(`[remotion-media-mcp] Music task created: ${taskId}`);

      // Poll for completion using music-specific polling
      const pollResult = await pollMusicTaskStatus(taskId, apiKey);

      if (!pollResult.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pollResult.error}` }],
        };
      }

      // Download audio
      const filename = output_name || `music-${Date.now()}`;
      const outputPath = path.resolve(process.cwd(), "public", `${filename}.mp3`);

      console.error(`[remotion-media-mcp] Downloading music to ${outputPath}...`);
      await downloadFile(pollResult.audioUrl!, outputPath);
      console.error(`[remotion-media-mcp] Music saved successfully!`);

      // Airtable post-generation hook
      const postResult = await postGenerationHook({
        remoteUrl: pollResult.audioUrl,
        localPath: outputPath,
        filename: `${filename}.mp3`,
        description: prompt,
        fileType: "audio",
        sourceTool: "generate_music",
        taskId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: outputPath,
                relativePath: `public/${filename}.mp3`,
                taskId,
                audioUrl: pollResult.audioUrl,
                title: pollResult.title,
                duration: pollResult.duration,
                imageUrl: pollResult.imageUrl,
                ...(postResult?.aid && { aid: postResult.aid }),
                ...(postResult?.recordId && { airtableRecordId: postResult.recordId }),
                ...(postResult?.assetsPath && { assetsPath: postResult.assetsPath }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating music: ${message}` }],
      };
    }
  }
);

// Tool 6: Generate Speech using ElevenLabs Text-to-Speech
server.tool(
  "generate_speech",
  "Convert text to natural-sounding speech audio (text-to-speech / TTS). Use for: voiceovers, narration, dialogue, announcements, or any spoken content. 21 voices available (default: Eric). Adjustable stability, similarity, and speed. Max 5000 characters. Returns downloaded MP3 path in public/ folder.",
  {
    text: z.string().max(5000).describe("Text to convert to speech (max 5000 chars)"),
    output_name: z.string().describe("Output filename without extension"),
    voice: z
      .enum([
        "Rachel", "Aria", "Roger", "Sarah", "Laura", "Charlie",
        "George", "Callum", "River", "Liam", "Charlotte", "Alice",
        "Matilda", "Will", "Jessica", "Eric", "Chris", "Brian",
        "Daniel", "Lily", "Bill"
      ])
      .optional()
      .describe("Voice to use. Defaults to Eric"),
    model: z
      .enum(["multilingual_v2", "turbo_v2_5"])
      .optional()
      .describe("TTS model. multilingual = best quality, turbo = faster. Defaults to turbo_v2_5"),
    stability: z.number().min(0).max(1).optional().describe("Voice stability 0-1. Lower = more expressive. Default 0.5"),
    similarity_boost: z.number().min(0).max(1).optional().describe("Voice similarity 0-1. Higher = closer to original. Default 0.75"),
    speed: z.number().min(0.7).max(1.2).optional().describe("Speech speed 0.7-1.2. Default 1.0"),
  },
  async ({ text, output_name, voice, model, stability, similarity_boost, speed }) => {
    try {
      const apiKey = getApiKey();
      console.error(`[remotion-media-mcp] Starting speech generation: "${text.substring(0, 50)}..."`);

      // Map model parameter to API model name
      const modelMap: Record<string, string> = {
        turbo_v2_5: "elevenlabs/text-to-speech-turbo-2-5",
        multilingual_v2: "elevenlabs/text-to-speech-multilingual-v2",
      };
      const apiModel = modelMap[model || "turbo_v2_5"];

      // Build input for the TTS model
      const input: Record<string, any> = {
        text,
        voice: voice || "Eric",
        stability: stability ?? 0.5,
        similarity_boost: similarity_boost ?? 0.75,
        speed: speed ?? 1.0,
      };

      // Create speech task using jobs/createTask
      const createResponse = await fetch(`${API_BASE}/api/v1/jobs/createTask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: apiModel,
          input,
        }),
      });

      const createResult = await createResponse.json();
      console.error(`[remotion-media-mcp] API response:`, JSON.stringify(createResult, null, 2));

      if (createResult.code !== 200) {
        return {
          content: [{ type: "text" as const, text: `Error creating speech task: ${createResult.msg || JSON.stringify(createResult)}` }],
        };
      }

      const taskId = createResult.data?.taskId;
      console.error(`[remotion-media-mcp] Speech task created: ${taskId}`);

      // Poll for completion using standard polling
      const pollResult = await pollTaskStatus(taskId, apiKey);

      if (!pollResult.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pollResult.error}` }],
        };
      }

      // Extract audio URL from result
      const resultJson = JSON.parse(pollResult.data.resultJson);
      const audioUrl = resultJson.resultUrls?.[0] || resultJson.audio_url || resultJson.audioUrl;

      if (!audioUrl) {
        console.error(`[remotion-media-mcp] Result JSON:`, JSON.stringify(resultJson, null, 2));
        return {
          content: [{ type: "text" as const, text: "Error: No audio URL in response" }],
        };
      }

      // Download audio
      const filename = output_name || `speech-${Date.now()}`;
      const outputPath = path.resolve(process.cwd(), "public", `${filename}.mp3`);

      console.error(`[remotion-media-mcp] Downloading speech to ${outputPath}...`);
      await downloadFile(audioUrl, outputPath);
      console.error(`[remotion-media-mcp] Speech saved successfully!`);

      // Airtable post-generation hook
      const postResult = await postGenerationHook({
        remoteUrl: audioUrl,
        localPath: outputPath,
        filename: `${filename}.mp3`,
        description: text,
        fileType: "audio",
        sourceTool: "generate_speech",
        taskId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: outputPath,
                relativePath: `public/${filename}.mp3`,
                taskId,
                audioUrl,
                voice: voice || "Eric",
                model: model || "turbo_v2_5",
                ...(postResult?.aid && { aid: postResult.aid }),
                ...(postResult?.recordId && { airtableRecordId: postResult.recordId }),
                ...(postResult?.assetsPath && { assetsPath: postResult.assetsPath }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating speech: ${message}` }],
      };
    }
  }
);

// Tool 7: Generate subtitles using local Whisper
server.tool(
  "generate_subtitles",
  "Transcribe audio/video to SRT subtitles using local Whisper. Requires whisper-cpp (brew install whisper-cpp) or OpenAI whisper (pip install openai-whisper). Input file must be in public/ folder. Returns path to generated .srt file.",
  {
    input_file: z.string().describe("Filename in public/ folder (e.g., 'video.mp4' or 'audio.mp3')"),
    output_name: z.string().optional().describe("Output filename without extension. Defaults to input filename"),
    language: z.string().optional().describe("Language code (e.g., 'en', 'es', 'fr'). Auto-detects if not specified"),
    model: z
      .enum(["tiny", "base", "small", "medium", "large"])
      .optional()
      .describe("Whisper model size. tiny=fastest, large=most accurate. Default: base"),
  },
  async ({ input_file, output_name, language, model }) => {
    try {
      // 1. Check whisper is installed
      const whisperInfo = getWhisperCommand();
      if (!whisperInfo) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Whisper not installed",
                  message: "This tool requires whisper-cpp or openai-whisper to be installed locally.",
                  install_instructions: {
                    mac: "brew install whisper-cpp",
                    pip: "pip install openai-whisper",
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 2. Verify input file exists in public/
      const publicDir = path.resolve(process.cwd(), "public");
      const inputPath = path.join(publicDir, input_file);

      if (!fs.existsSync(inputPath)) {
        // List available files for helpful error message
        const availableFiles: string[] = [];
        if (fs.existsSync(publicDir)) {
          const files = fs.readdirSync(publicDir);
          const mediaFiles = files.filter((f) =>
            /\.(mp4|mp3|wav|webm|mov|m4a|ogg|flac|mkv|avi)$/i.test(f)
          );
          availableFiles.push(...mediaFiles);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "File not found",
                  message: `Could not find '${input_file}' in public/ folder`,
                  available_files: availableFiles.length > 0 ? availableFiles : "No media files found",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 3. Determine output filename
      const baseName = output_name || path.basename(input_file, path.extname(input_file));
      const outputSrtPath = path.join(publicDir, `${baseName}.srt`);
      const modelSize = model || "base";

      console.error(`[remotion-media-mcp] Starting subtitle generation with ${whisperInfo.type}...`);
      console.error(`[remotion-media-mcp] Input: ${inputPath}`);
      console.error(`[remotion-media-mcp] Model: ${modelSize}`);

      let command: string;
      let srtOutputPath: string;

      if (whisperInfo.type === "whisper-cpp") {
        // whisper.cpp command (whisper-cli)
        // Look for models in common locations
        const modelFileName = `ggml-${modelSize}.bin`;
        const possibleModelPaths = [
          path.join(process.cwd(), "models", modelFileName),
          path.join(process.env.HOME || "", ".cache", "whisper", modelFileName),
          `/opt/homebrew/share/whisper-cpp/models/${modelFileName}`,
          path.join(process.cwd(), modelFileName),
        ];

        let modelPath: string | null = null;
        for (const p of possibleModelPaths) {
          if (fs.existsSync(p)) {
            modelPath = p;
            break;
          }
        }

        // If model not found, download it
        if (!modelPath) {
          const modelsDir = path.join(process.cwd(), "models");
          if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
          }
          modelPath = path.join(modelsDir, modelFileName);

          console.error(`[remotion-media-mcp] Model not found locally, downloading ${modelSize} model...`);

          // Download model from Hugging Face
          const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName}`;
          try {
            const response = await fetch(modelUrl);
            if (!response.ok) {
              throw new Error(`Failed to download model: ${response.statusText}`);
            }
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(modelPath, Buffer.from(buffer));
            console.error(`[remotion-media-mcp] Model downloaded to ${modelPath}`);
          } catch (downloadError: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: "Model download failed",
                      message: `Could not download whisper model '${modelSize}'`,
                      details: downloadError.message,
                      manual_download: `Download from ${modelUrl} and place in ./models/`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        // whisper-cli outputs to <output_prefix>.srt
        const outputPrefix = path.join(publicDir, baseName);
        srtOutputPath = `${outputPrefix}.srt`;

        command = `"${whisperInfo.cmd}" -m "${modelPath}" -f "${inputPath}" -osrt -of "${outputPrefix}"`;
        if (language) {
          command += ` -l ${language}`;
        }
      } else {
        // OpenAI whisper command
        srtOutputPath = outputSrtPath;

        command = `whisper "${inputPath}" --output_format srt --output_dir "${publicDir}" --model ${modelSize}`;
        if (language) {
          command += ` --language ${language}`;
        }
      }

      console.error(`[remotion-media-mcp] Running: ${command}`);

      // 4. Run whisper command
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 600000, // 10 minute timeout
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        });

        if (stderr) {
          console.error(`[remotion-media-mcp] Whisper stderr: ${stderr}`);
        }
        if (stdout) {
          console.error(`[remotion-media-mcp] Whisper stdout: ${stdout}`);
        }
      } catch (execError: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Transcription failed",
                  message: execError.message,
                  stderr: execError.stderr,
                  stdout: execError.stdout,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // For OpenAI whisper, rename output if needed
      if (whisperInfo.type === "openai-whisper") {
        const whisperDefaultOutput = path.join(
          publicDir,
          `${path.basename(input_file, path.extname(input_file))}.srt`
        );
        if (output_name && whisperDefaultOutput !== srtOutputPath) {
          if (fs.existsSync(whisperDefaultOutput)) {
            fs.renameSync(whisperDefaultOutput, srtOutputPath);
          }
        } else {
          srtOutputPath = whisperDefaultOutput;
        }
      }

      // 5. Verify output exists
      if (!fs.existsSync(srtOutputPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Output not found",
                  message: `Expected SRT file at ${srtOutputPath} but it was not created`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      console.error(`[remotion-media-mcp] Subtitles generated successfully!`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                path: srtOutputPath,
                relativePath: `public/${path.basename(srtOutputPath)}`,
                whisperCommand: whisperInfo.type,
                model: modelSize,
                language: language || "auto-detected",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating subtitles: ${message}` }],
      };
    }
  }
);

// Tool 8: List Assets
server.tool(
  "list_assets",
  "Browse assets stored in the asset library. Shows AID, filename, description, file type, and creation date. Supports filtering by file type and pagination. Requires AIRTABLE_API_KEY to be configured.",
  {
    file_type: z
      .enum(["image", "video", "audio", "subtitle", "other"])
      .optional()
      .describe("Filter by file type"),
    max_records: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum records to return (default: 20, max: 100)"),
    page_offset: z
      .string()
      .optional()
      .describe("Pagination offset from a previous list call"),
  },
  async ({ file_type, max_records, page_offset }) => {
    try {
      const config = getAirtableConfig();
      if (!config) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Airtable not configured",
                  message:
                    "Set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and optionally AIRTABLE_TABLE_NAME environment variables to enable Airtable integration.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Build filter formula for file type
      let filterByFormula: string | undefined;
      if (file_type) {
        const mimePrefix: Record<string, string> = {
          image: "image/",
          video: "video/",
          audio: "audio/",
          subtitle: "text/",
          other: "",
        };
        const prefix = mimePrefix[file_type];
        if (prefix) {
          filterByFormula = `SEARCH("${prefix}", {MIME Type}) > 0`;
        }
      }

      const result = await listAirtableRecords(config, {
        filterByFormula,
        maxRecords: max_records || 20,
        offset: page_offset,
      });

      const assets = result.records.map((r) => ({
        aid: r.fields.AID || "",
        filename: r.fields.Filename || "",
        description: r.fields.Description || "",
        mimeType: r.fields["MIME Type"] || "",
        fileType: r.fields.Filename ? detectFileType(r.fields.Filename) : "other",
        hasAttachment: Array.isArray(r.fields.File) && r.fields.File.length > 0,
        createdAt: r.createdTime || "",
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                count: assets.length,
                assets,
                ...(result.offset && { nextPageOffset: result.offset }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error listing Airtable assets: ${message}` }],
      };
    }
  }
);

// Tool 9: Backup Asset
server.tool(
  "backup_asset",
  "Back up a local file to the asset library. Supports files from assets/, out/, public/, or any relative path. Creates a record with metadata and file attachment, assigns an AID, and optionally renames the local file with the AID prefix. Requires AIRTABLE_API_KEY to be configured.",
  {
    file_path: z
      .string()
      .describe(
        "Path to the local file (e.g., 'assets/hero.png', 'out/video.mp4', 'public/music.mp3', or any relative/absolute path)"
      ),
    description: z.string().describe("Description of the asset"),
    file_type: z
      .enum(["image", "video", "audio", "subtitle", "other"])
      .optional()
      .describe("File type (auto-detected from extension if not specified)"),
    remote_url: z
      .string()
      .optional()
      .describe("Optional remote URL for the file (used as attachment instead of uploading)"),
  },
  async ({ file_path, description, file_type, remote_url }) => {
    try {
      const config = getAirtableConfig();
      if (!config) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Airtable not configured",
                  message:
                    "Set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and optionally AIRTABLE_TABLE_NAME environment variables to enable Airtable integration.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Resolve the file path - search common directories
      let resolvedPath: string | null = null;
      const searchDirs = ["public", "out"];
      const cwd = process.cwd();

      if (path.isAbsolute(file_path)) {
        if (fs.existsSync(file_path)) resolvedPath = file_path;
      } else {
        // Try the path as-is first (relative to cwd)
        const directPath = path.resolve(cwd, file_path);
        if (fs.existsSync(directPath)) {
          resolvedPath = directPath;
        } else {
          // Search in common directories
          for (const dir of searchDirs) {
            const candidate = path.resolve(cwd, dir, path.basename(file_path));
            if (fs.existsSync(candidate)) {
              resolvedPath = candidate;
              break;
            }
          }
        }
      }

      if (!resolvedPath) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "File not found",
                  message: `Could not find '${file_path}'. Searched in: ${searchDirs.join(", ")} directories and as relative/absolute path.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const filename = path.basename(resolvedPath);
      const detectedType = file_type || detectFileType(filename);
      const mimeType = getMimeType(filename);

      // Create Airtable record
      const record = await createAirtableRecord(config, {
        description,
        fileUrl: remote_url,
        filename,
        mimeType,
      });

      if (!record) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "Failed to create Airtable record" },
                null,
                2
              ),
            },
          ],
        };
      }

      const { aid, recordId } = record;

      // If no remote URL, upload the file directly
      if (!remote_url) {
        await uploadAttachmentToAirtable(config, recordId, resolvedPath, filename);
      }

      // Rename file with AID prefix if it's in assets/ and not already prefixed
      let renamedTo: string | undefined;
      const parentDir = path.basename(path.dirname(resolvedPath));
      if (parentDir === "assets" && aid && !/^A\d+-/.test(filename)) {
        const newFilename = `${aid}-${filename}`;
        const newPath = path.join(path.dirname(resolvedPath), newFilename);
        fs.renameSync(resolvedPath, newPath);
        renamedTo = newFilename;
        console.error(`[remotion-media-mcp] Renamed ${filename} → ${newFilename}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                aid,
                recordId,
                filename,
                fileType: detectedType,
                ...(renamedTo && { renamedTo }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error backing up to Airtable: ${message}` }],
      };
    }
  }
);

// Tool 10: Get Asset
server.tool(
  "get_asset",
  "Pull an asset from the library by its AID. Downloads the attachment and saves it locally with the AID-prefixed filename. Requires AIRTABLE_API_KEY to be configured.",
  {
    aid: z
      .string()
      .describe("The AID of the asset to download (e.g., 'A42')"),
    target_dir: z
      .string()
      .optional()
      .describe(
        "Target directory: 'assets' (default), 'out', 'public', or any relative/absolute path"
      ),
  },
  async ({ aid, target_dir }) => {
    try {
      const config = getAirtableConfig();
      if (!config) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Airtable not configured",
                  message:
                    "Set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and optionally AIRTABLE_TABLE_NAME environment variables to enable Airtable integration.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Look up record by AID
      const record = await getAirtableRecordByAid(config, aid);
      if (!record) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "Asset not found", message: `No asset found with AID "${aid}"` },
                null,
                2
              ),
            },
          ],
        };
      }

      // Get attachment URL
      const files = record.fields.File;
      if (!Array.isArray(files) || files.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "No attachment",
                  message: `Asset ${aid} exists but has no file attachment in Airtable.`,
                  record: {
                    aid: record.fields.AID,
                    filename: record.fields.Filename,
                    description: record.fields.Description,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const attachmentUrl = files[0].url;
      const originalFilename = files[0].filename || record.fields.Filename || "unknown";
      const recordAid = record.fields.AID || aid;

      // Build AID-prefixed filename
      const aidPrefix = `${recordAid}-`;
      const targetFilename = originalFilename.startsWith(aidPrefix)
        ? originalFilename
        : `${aidPrefix}${originalFilename}`;

      // Resolve target directory
      const dirName = target_dir || "public";
      let targetDirPath: string;
      if (path.isAbsolute(dirName)) {
        targetDirPath = dirName;
      } else {
        targetDirPath = path.resolve(process.cwd(), dirName);
      }

      // Ensure directory exists
      if (!fs.existsSync(targetDirPath)) {
        fs.mkdirSync(targetDirPath, { recursive: true });
      }

      const outputPath = path.join(targetDirPath, targetFilename);

      // Download the file
      console.error(`[remotion-media-mcp] Downloading ${recordAid} to ${outputPath}...`);
      await downloadFile(attachmentUrl, outputPath);
      console.error(`[remotion-media-mcp] Downloaded successfully!`);

      const relativePath = path.relative(process.cwd(), outputPath);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                aid: recordAid,
                path: outputPath,
                relativePath,
                filename: targetFilename,
                description: record.fields.Description || "",
                mimeType: record.fields["MIME Type"] || "",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error copying from Airtable: ${message}` }],
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const airtableConfig = getAirtableConfig();
  console.error(
    `[remotion-media-mcp] Airtable integration: ${airtableConfig ? "enabled" : "disabled"}`
  );
  console.error("[remotion-media-mcp] Server started");
}

main().catch((error) => {
  console.error("[remotion-media-mcp] Fatal error:", error);
  process.exit(1);
});
