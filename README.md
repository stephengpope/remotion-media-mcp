# Remotion Media MCP

An MCP (Model Context Protocol) server for AI-powered media generation. Generate images, videos, music, sound effects, speech, and subtitles directly from Claude or any MCP-compatible client.

All generated files save to `public/` — ready for Remotion's `staticFile()` or any other use.

## Quick Start

### Install globally

```bash
npm install -g remotion-media-mcp
```

### Add to Claude Code

If installed globally or via npx:

```bash
claude mcp add remotion-media \
  -e KIE_API_KEY=your-api-key \
  -- npx remotion-media-mcp
```

If cloned and built locally:

```bash
claude mcp add remotion-media \
  -e KIE_API_KEY=your-api-key \
  -- node /path/to/remotion-media-mcp/dist/index.js
```

With optional Airtable asset tracking:

```bash
claude mcp add remotion-media \
  -e KIE_API_KEY=your-api-key \
  -e AIRTABLE_API_KEY=your-airtable-pat \
  -e AIRTABLE_BASE_ID=appXXX \
  -e AIRTABLE_TABLE_NAME=Assets \
  -- npx remotion-media-mcp
```

> By default this adds at user scope (`-s user`). Add `-s project` to scope it to the current project only.

### Add to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "remotion-media": {
      "command": "npx",
      "args": ["remotion-media-mcp"],
      "env": {
        "KIE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Add to `.mcp.json`

```json
{
  "mcpServers": {
    "remotion-media": {
      "command": "npx",
      "args": ["remotion-media-mcp"],
      "env": {
        "KIE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## API Key

Get a KIE_API_KEY from [kie.ai](https://kie.ai) — sign up and grab your key from the dashboard.

## Tools

### `generate_image`

Generate AI images via Nano Banana Pro.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the image |
| `output_name` | string | Yes | Output filename (without extension) |
| `aspect_ratio` | enum | No | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, auto |
| `resolution` | enum | No | 1K, 2K, 4K (default: 1K) |
| `image_urls` | string[] | No | Reference images (up to 8) |

### `generate_video_from_text`

Text-to-video via Veo 3.1. Creates ~8 second clips.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the video |
| `output_name` | string | Yes | Output filename (without extension) |
| `model` | enum | No | veo3 (quality) or veo3_fast (speed, default) |
| `aspect_ratio` | enum | No | 16:9 (default), 9:16, Auto |

### `generate_video_from_image`

Animate a still image or transition between two images via Veo 3.1.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the animation |
| `image_urls` | string[] | Yes | 1-2 image URLs |
| `output_name` | string | Yes | Output filename (without extension) |
| `model` | enum | No | veo3 (quality) or veo3_fast (speed, default) |
| `aspect_ratio` | enum | No | 16:9 (default), 9:16, Auto |

### `generate_music`

Generate AI music via Suno.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the music (max 500 chars) |
| `output_name` | string | Yes | Output filename (without extension) |
| `instrumental` | boolean | No | Instrumental only, no vocals (default: false) |
| `model` | enum | No | V3_5, V4, V4_5, V4_5PLUS, V5 (default) |

### `generate_sound_effect`

Generate sound effects via ElevenLabs SFX V2.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the sound (max 450 chars) |
| `output_name` | string | Yes | Output filename (without extension) |
| `duration_seconds` | number | No | Duration 0.5-22 seconds |
| `loop` | boolean | No | Generate seamless loop (default: false) |

### `generate_speech`

Text-to-speech via ElevenLabs TTS. 21 voices available.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | Text to convert (max 5000 chars) |
| `output_name` | string | Yes | Output filename (without extension) |
| `voice` | enum | No | Default: Eric. Options: Rachel, Aria, Roger, Sarah, Laura, Charlie, George, Callum, River, Liam, Charlotte, Alice, Matilda, Will, Jessica, Eric, Chris, Brian, Daniel, Lily, Bill |
| `model` | enum | No | multilingual_v2 (quality) or turbo_v2_5 (faster, default) |
| `stability` | number | No | Voice stability 0-1 (default: 0.5) |
| `similarity_boost` | number | No | Voice similarity 0-1 (default: 0.75) |
| `speed` | number | No | Speech speed 0.7-1.2 (default: 1.0) |

### `generate_subtitles`

Transcribe audio/video to SRT subtitles using local Whisper.

Requires [whisper.cpp](https://github.com/ggerganov/whisper.cpp) or [OpenAI Whisper](https://github.com/openai/whisper):

```bash
brew install whisper-cpp    # recommended
# or
pip install openai-whisper
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input_file` | string | Yes | Filename in public/ folder |
| `output_name` | string | No | Output filename without extension |
| `language` | string | No | Language code e.g., 'en', 'es' (default: auto-detect) |
| `model` | enum | No | tiny, base (default), small, medium, large |

### `list_assets`

Browse assets in the Airtable asset library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_type` | enum | No | Filter: image, video, audio, subtitle, other |
| `max_records` | number | No | Max records (default: 20, max: 100) |
| `page_offset` | string | No | Pagination offset |

### `backup_asset`

Back up a local file to the asset library. Assigns an AID and optionally renames with AID prefix.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to local file |
| `description` | string | Yes | Description of the asset |
| `file_type` | enum | No | Auto-detected from extension |
| `remote_url` | string | No | Remote URL instead of uploading |

### `get_asset`

Pull an asset from the library by AID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `aid` | string | Yes | Asset ID (e.g., 'A42') |
| `target_dir` | string | No | Target: 'assets' (default), 'out', 'public' |

## Using with Remotion

Generated files land in `public/` and work directly with `staticFile()`:

```tsx
import { Img, Video, Audio, staticFile } from "remotion";

<Img src={staticFile("hero.png")} />
<Video src={staticFile("intro.mp4")} />
<Audio src={staticFile("bgm.mp3")} />
```

## Airtable Integration (Optional)

Connect Airtable to auto-track every generated asset with a unique AID.

### Setup

1. Create an [Airtable Personal Access Token](https://airtable.com/create/tokens) with `data.records:read`, `data.records:write`, and `content:manage` scopes
2. Create a base with a table (default name: "Assets") with these fields:

| Field | Type | Notes |
|-------|------|-------|
| `AID` | Formula | `"A" & {ID}` |
| `ID` | Auto number | |
| `Filename` | Single line text | |
| `Description` | Long text | |
| `File` | Attachment | |
| `MIME Type` | Single line text | |
| `Record ID` | Formula | `RECORD_ID()` |

3. Set the env vars: `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, and optionally `AIRTABLE_TABLE_NAME`

Without Airtable configured, everything works normally — generation tools save to `public/` and asset library tools return a "not configured" message.

## Local Development

```bash
git clone https://github.com/stephengpope/remotion-media-mcp.git
cd remotion-media-mcp
npm install
npm run build

# Run locally
KIE_API_KEY=your-key node dist/index.js

# Add your local build to Claude Code
claude mcp add remotion-media \
  -e KIE_API_KEY=your-key \
  -- node $PWD/dist/index.js
```

## License

MIT
