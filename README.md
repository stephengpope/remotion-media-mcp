# Remotion Media MCP

An MCP (Model Context Protocol) server for AI-powered media generation in Remotion projects. Generate images, videos, music, and sound effects directly from Claude or any MCP-compatible client.

## Features

- **Image Generation** - AI images via Nano Banana Pro
- **Video Generation** - Text-to-video and image-to-video via Veo 3.1 or ByteDance Seedance
  - **Veo 3.1** - Google's video model, ~8 second clips
  - **Seedance 2.0** - ByteDance's latest model with native audio, 4-15 second clips, 2K resolution, multi-shot consistency
  - **Seedance 1.5 Pro** - Reliable model with audio support, 4-12 second clips
- **Music Generation** - AI music via Suno (V3.5 - V5)
- **Sound Effects** - AI sound effects via ElevenLabs SFX V2
- **Text-to-Speech** - Natural voiceovers via ElevenLabs TTS
- **Subtitle Generation** - Transcribe audio/video to SRT via local Whisper
- **Asset Library** - Browse, back up, and pull assets with AID tracking via optional Airtable integration

## Installation

```bash
npm install -g remotion-media-mcp
```

Or use with npx:

```bash
npx remotion-media-mcp
```

## Configuration

### Get an API Key

1. Sign up at [kie.ai](https://kie.ai)
2. Get your API key from the dashboard

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "remotion-media": {
      "command": "npx",
      "args": ["remotion-media-mcp"],
      "env": {
        "KIE_API_KEY": "your-api-key-here",
        "AIRTABLE_API_KEY": "your-airtable-pat-here",
        "AIRTABLE_BASE_ID": "appXXXXXXXXXXXXXX",
        "AIRTABLE_TABLE_NAME": "Assets"
      }
    }
  }
}
```

### Claude Code (CLI)

Add with a single command:

```bash
claude mcp add remotion-media -s project -e KIE_API_KEY=your-api-key -e AIRTABLE_API_KEY=your-airtable-pat -e AIRTABLE_BASE_ID=appXXX -e AIRTABLE_TABLE_NAME=Assets -- npx remotion-media-mcp
```

Or manually add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "remotion-media": {
      "command": "npx",
      "args": ["remotion-media-mcp"],
      "env": {
        "KIE_API_KEY": "your-api-key-here",
        "AIRTABLE_API_KEY": "your-airtable-pat-here",
        "AIRTABLE_BASE_ID": "appXXXXXXXXXXXXXX",
        "AIRTABLE_TABLE_NAME": "Assets"
      }
    }
  }
}
```

> **Note:** The Airtable env vars are optional. Without them, everything works exactly as before. See [Airtable Integration](#airtable-integration-optional) for setup details.

## Available Tools

### `generate_image`

Generate AI images using Nano Banana Pro.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the image |
| `output_name` | string | Yes | Output filename (without extension) |
| `aspect_ratio` | enum | No | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, auto |
| `resolution` | enum | No | 1K, 2K, 4K (default: 1K) |
| `image_urls` | string[] | No | Reference images (up to 8) |

### `generate_video_from_text`

Generate videos from text prompts using Veo 3.1 or ByteDance Seedance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the video |
| `output_name` | string | Yes | Output filename (without extension) |
| `model` | enum | No | `veo3`, `veo3_fast` (default), `seedance_2`, `seedance_1_5_pro` |
| `aspect_ratio` | enum | No | 1:1, 4:3, 3:4, 16:9 (default), 9:16, 21:9, Auto |
| `duration` | enum | No | Video duration: 4, 8, 12, 15 seconds (Seedance only) |
| `resolution` | enum | No | 480p, 720p, 1080p, 2k (Seedance only, default: 1080p) |
| `generate_audio` | boolean | No | Generate native audio with video (Seedance only) |

**Model comparison:**

| Model | Duration | Resolution | Audio | Notes |
|-------|----------|------------|-------|-------|
| `veo3` | ~8s | 1080p | No | Google Veo, highest quality |
| `veo3_fast` | ~8s | 1080p | No | Google Veo, faster generation |
| `seedance_2` | 4-15s | Up to 2K | Yes | ByteDance latest, best motion & consistency |
| `seedance_1_5_pro` | 4-12s | Up to 1080p | Yes | ByteDance, reliable with audio sync |

### `generate_video_from_image`

Animate images or create transitions between frames using Veo 3.1 or ByteDance Seedance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the animation |
| `image_urls` | string[] | Yes | 1-5 image URLs (see model limits below) |
| `output_name` | string | Yes | Output filename (without extension) |
| `model` | enum | No | `veo3`, `veo3_fast` (default), `seedance_2`, `seedance_1_5_pro` |
| `aspect_ratio` | enum | No | 1:1, 4:3, 3:4, 16:9 (default), 9:16, 21:9, Auto |
| `duration` | enum | No | Video duration: 4, 8, 12, 15 seconds (Seedance only) |
| `resolution` | enum | No | 480p, 720p, 1080p, 2k (Seedance only, default: 1080p) |
| `generate_audio` | boolean | No | Generate native audio with video (Seedance only) |
| `fixed_lens` | boolean | No | Lock camera for static shots (Seedance 1.5 Pro only) |

**Image limits by model:**

| Model | Max Images | Notes |
|-------|------------|-------|
| `veo3` / `veo3_fast` | 2 | 1 image = animate, 2 images = transition |
| `seedance_1_5_pro` | 2 | 1-2 reference images |
| `seedance_2` | 5 | Up to 5 reference images for multi-shot consistency |

### `generate_music`

Generate AI music using Suno.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the music (max 500 chars) |
| `output_name` | string | Yes | Output filename (without extension) |
| `instrumental` | boolean | No | Instrumental only, no vocals (default: false) |
| `model` | enum | No | V3_5, V4, V4_5, V4_5PLUS, V5 (default) |

### `generate_sound_effect`

Generate AI sound effects using ElevenLabs SFX V2.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the sound (max 450 chars) |
| `output_name` | string | Yes | Output filename (without extension) |
| `duration_seconds` | number | No | Duration 0.5-22 seconds |
| `loop` | boolean | No | Generate seamless loop (default: false) |

### `generate_speech`

Convert text to natural-sounding speech using ElevenLabs TTS.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | Text to convert to speech (max 5000 chars) |
| `output_name` | string | Yes | Output filename (without extension) |
| `voice` | enum | No | Voice name (default: Eric). Options: Rachel, Aria, Roger, Sarah, Laura, Charlie, George, Callum, River, Liam, Charlotte, Alice, Matilda, Will, Jessica, Eric, Chris, Brian, Daniel, Lily, Bill |
| `model` | enum | No | multilingual_v2 (quality) or turbo_v2_5 (default, faster) |
| `stability` | number | No | Voice stability 0-1 (default: 0.5) |
| `similarity_boost` | number | No | Voice similarity 0-1 (default: 0.75) |
| `speed` | number | No | Speech speed 0.7-1.2 (default: 1.0) |

### `generate_subtitles`

Transcribe audio/video files to SRT subtitles using local Whisper. Requires [whisper.cpp](https://github.com/ggerganov/whisper.cpp) or [OpenAI Whisper](https://github.com/openai/whisper) to be installed.

```bash
# Install whisper.cpp (recommended)
brew install whisper-cpp

# Or install OpenAI Whisper
pip install openai-whisper
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input_file` | string | Yes | Filename in public/ folder (e.g., 'video.mp4') |
| `output_name` | string | No | Output filename without extension (default: input filename) |
| `language` | string | No | Language code e.g., 'en', 'es', 'fr' (default: auto-detect) |
| `model` | enum | No | tiny, base (default), small, medium, large |

**Note:** Models are automatically downloaded on first use (~75MB for base model).

### `list_assets`

Browse assets stored in the asset library. Requires Airtable integration to be configured.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_type` | enum | No | Filter by type: image, video, audio, subtitle, other |
| `max_records` | number | No | Max records to return (default: 20, max: 100) |
| `page_offset` | string | No | Pagination offset from previous call |

### `backup_asset`

Back up a local file to the asset library. Creates a record with metadata, uploads the file attachment, and assigns an AID. Files in `assets/` are automatically renamed with the AID prefix.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to local file (e.g., 'assets/hero.png', 'out/video.mp4') |
| `description` | string | Yes | Description of the asset |
| `file_type` | enum | No | File type (auto-detected if not specified) |
| `remote_url` | string | No | Remote URL to use as attachment instead of uploading |

### `get_asset`

Pull an asset from the library by its AID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `aid` | string | Yes | Asset ID (e.g., 'A42') |
| `target_dir` | string | No | Target directory: 'assets' (default), 'out', 'public', or any path |

## Output Location

All generated files are saved to the `public/` directory in your current working directory, making them immediately available via Remotion's `staticFile()` function:

```tsx
import { Audio, Img, Video, staticFile } from "remotion";

// Use generated assets
<Img src={staticFile("my-image.png")} />
<Video src={staticFile("my-video.mp4")} />
<Audio src={staticFile("my-music.mp3")} />
```

## Airtable Integration (Optional)

Connect an Airtable base to automatically track every generated asset with a unique AID (e.g., A1, A42), store metadata, and sync files between local directories and Airtable.

### Setup

1. Create an [Airtable Personal Access Token](https://airtable.com/create/tokens) with `data.records:read`, `data.records:write`, and `content:manage` scopes
2. Create an Airtable base with a table (default name: "Assets") with these fields:

| Field | Type | Notes |
|-------|------|-------|
| `AID` | Formula | `"A" & {ID}` — primary display field |
| `ID` | Auto number | Auto-incrementing integer |
| `Filename` | Single line text | |
| `Description` | Long text | |
| `File` | Attachment | |
| `MIME Type` | Single line text | |
| `Record ID` | Formula | `RECORD_ID()` |

3. Set the environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `AIRTABLE_API_KEY` | Yes | Airtable Personal Access Token |
| `AIRTABLE_BASE_ID` | Yes | Base ID (starts with `app...`) |
| `AIRTABLE_TABLE_NAME` | No | Table name (default: `"Assets"`) |

### How It Works

- **Auto-tracking**: Every file generated by `generate_image`, `generate_video_from_text`, `generate_video_from_image`, `generate_sound_effect`, `generate_music`, and `generate_speech` is automatically registered in Airtable with its metadata and remote URL attachment
- **AID assignment**: Each asset gets a unique AID (e.g., A1, A42) read back from the Airtable formula field
- **Asset copy**: Generated files are copied to `assets/` with AID-prefixed filenames (e.g., `assets/A42-hero.png`) for traceability
- **Non-blocking**: Airtable errors never break media generation — the file is always saved to `public/` regardless
- **Push/pull**: Use `backup_asset` to push local files and `get_asset` to pull files by AID

### Limitations

Airtable attachments are limited to 5MB on free plans and 100MB on paid plans. For larger files (long videos, lossless audio), a future version may support S3 or similar object storage as an intermediary, with Airtable storing only the metadata and a reference URL.

### Without Airtable

If `AIRTABLE_API_KEY` is not set, the MCP works exactly as before. Generation tools save to `public/` only, and the asset library tools (`list_assets`, `backup_asset`, `get_asset`) return a "not configured" message.

## Development

```bash
# Clone the repo
git clone https://github.com/stephengpope/remotion-media-mcp.git
cd remotion-media-mcp

# Install dependencies
npm install

# Build
npm run build

# Run locally
KIE_API_KEY=your-key node dist/index.js
```

## License

MIT
