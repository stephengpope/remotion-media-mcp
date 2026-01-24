# Remotion Media MCP

An MCP (Model Context Protocol) server for AI-powered media generation in Remotion projects. Generate images, videos, music, and sound effects directly from Claude or any MCP-compatible client.

## Features

- **Image Generation** - AI images via Nano Banana Pro
- **Video Generation** - Text-to-video and image-to-video via Veo 3.1
- **Music Generation** - AI music via Suno (V3.5 - V5)
- **Sound Effects** - AI sound effects via ElevenLabs SFX V2
- **Text-to-Speech** - Natural voiceovers via ElevenLabs TTS
- **Subtitle Generation** - Transcribe audio/video to SRT via local Whisper
- **Asset Management** - List all generated media in your project

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
        "KIE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Code (CLI)

Add with a single command:

```bash
claude mcp add remotion-media -s project -e KIE_API_KEY=your-api-key -- npx remotion-media-mcp
```

Or manually add to your project's `.mcp.json`:

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

Generate videos from text prompts using Veo 3.1.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the video |
| `output_name` | string | Yes | Output filename (without extension) |
| `model` | enum | No | veo3 (quality) or veo3_fast (default) |
| `aspect_ratio` | enum | No | 16:9 (default), 9:16, Auto |

### `generate_video_from_image`

Animate images or create transitions between frames using Veo 3.1.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the animation |
| `image_urls` | string[] | Yes | 1-2 image URLs |
| `output_name` | string | Yes | Output filename (without extension) |
| `model` | enum | No | veo3 (quality) or veo3_fast (default) |
| `aspect_ratio` | enum | No | 16:9 (default), 9:16, Auto |

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

### `list_generated_media`

List all generated images, videos, and audio files in your project's `public/` folder.

## Output Location

All generated files are saved to the `public/` directory in your current working directory, making them immediately available via Remotion's `staticFile()` function:

```tsx
import { Audio, Img, Video, staticFile } from "remotion";

// Use generated assets
<Img src={staticFile("my-image.png")} />
<Video src={staticFile("my-video.mp4")} />
<Audio src={staticFile("my-music.mp3")} />
```

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
