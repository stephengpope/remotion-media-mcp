#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

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
  "Generate an AI image using kie.ai Nano Banana Pro model. Returns the path to the downloaded image.",
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
  "Generate an AI video from text prompt using kie.ai Veo 3.1. Returns the path to the downloaded video.",
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
  "Generate an AI video from image(s) using kie.ai Veo 3.1. Supports 1 image (animate) or 2 images (transition between first and last frame).",
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
  "Generate an AI sound effect using kie.ai ElevenLabs SFX V2. Returns the path to the downloaded audio file.",
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
  "Generate AI music using kie.ai Suno API. Returns the path to the downloaded audio file.",
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

// Tool 6: List generated media
server.tool(
  "list_generated_media",
  "List all generated images, videos, and audio files in the public folder",
  {},
  async () => {
    const publicDir = path.resolve(process.cwd(), "public");

    if (!fs.existsSync(publicDir)) {
      return {
        content: [{ type: "text" as const, text: "No public directory found." }],
      };
    }

    const files = fs.readdirSync(publicDir);
    const images = files.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
    const videos = files.filter((f) => /\.(mp4|webm|mov)$/i.test(f));
    const audio = files.filter((f) => /\.(mp3|wav|ogg|m4a)$/i.test(f));

    const output = [];
    if (images.length > 0) {
      output.push(`Images:\n${images.map((f) => `  - public/${f}`).join("\n")}`);
    }
    if (videos.length > 0) {
      output.push(`Videos:\n${videos.map((f) => `  - public/${f}`).join("\n")}`);
    }
    if (audio.length > 0) {
      output.push(`Audio:\n${audio.map((f) => `  - public/${f}`).join("\n")}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: output.length > 0 ? output.join("\n\n") : "No generated media found.",
        },
      ],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[remotion-media-mcp] Server started");
}

main().catch((error) => {
  console.error("[remotion-media-mcp] Fatal error:", error);
  process.exit(1);
});
