import * as fs from "fs";
import * as path from "path";

export interface AirtableConfig {
  apiKey: string;
  baseId: string;
  tableName: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

export function getAirtableConfig(): AirtableConfig | null {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    baseId: process.env.AIRTABLE_BASE_ID || "",
    tableName: process.env.AIRTABLE_TABLE_NAME || "Assets",
  };
}

export async function airtableRequest(
  config: AirtableConfig,
  endpoint: string,
  options: RequestInit = {}
): Promise<any> {
  const url = `https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(config.tableName)}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Airtable API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

export async function createAirtableRecord(
  config: AirtableConfig,
  params: {
    description: string;
    fileUrl?: string;
    filename: string;
    mimeType: string;
  }
): Promise<{ aid: string; recordId: string } | null> {
  try {
    const fields: Record<string, any> = {
      Filename: params.filename,
      Description: params.description,
      "MIME Type": params.mimeType,
    };

    if (params.fileUrl) {
      fields.File = [{ url: params.fileUrl }];
    }

    const result = await airtableRequest(config, "", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });

    const aid = result.fields?.AID || "";
    return { aid, recordId: result.id };
  } catch (error) {
    console.error(
      `[remotion-media-mcp] Airtable create record failed:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export async function listAirtableRecords(
  config: AirtableConfig,
  params: {
    filterByFormula?: string;
    maxRecords?: number;
    offset?: string;
  } = {}
): Promise<{ records: AirtableRecord[]; offset?: string }> {
  const queryParams = new URLSearchParams();

  if (params.filterByFormula) {
    queryParams.set("filterByFormula", params.filterByFormula);
  }
  if (params.maxRecords) {
    queryParams.set("maxRecords", String(params.maxRecords));
  }
  if (params.offset) {
    queryParams.set("offset", params.offset);
  }

  // Sort by ID descending (newest first)
  queryParams.set("sort[0][field]", "ID");
  queryParams.set("sort[0][direction]", "desc");

  // Request specific fields
  const fields = ["AID", "ID", "Filename", "Description", "MIME Type", "File", "Record ID"];
  fields.forEach((f, i) => {
    queryParams.set(`fields[${i}]`, f);
  });

  const query = queryParams.toString();
  const endpoint = query ? `?${query}` : "";

  const result = await airtableRequest(config, endpoint);
  return { records: result.records || [], offset: result.offset };
}

export async function getAirtableRecordByAid(
  config: AirtableConfig,
  aid: string
): Promise<AirtableRecord | null> {
  // Extract number from AID (e.g., "A42" → 42)
  const match = aid.match(/^A(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid AID format: "${aid}". Expected format like "A42".`);
  }

  const idNumber = match[1];
  const result = await listAirtableRecords(config, {
    filterByFormula: `{ID}=${idNumber}`,
    maxRecords: 1,
  });

  return result.records.length > 0 ? result.records[0] : null;
}

export async function uploadAttachmentToAirtable(
  config: AirtableConfig,
  recordId: string,
  filePath: string,
  filename: string
): Promise<boolean> {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const contentType = getMimeType(filename);

    // Airtable content upload API: base64-encoded file in JSON body
    // URL format: content.airtable.com/v0/{baseId}/{recordId}/{fieldIdOrName}/uploadAttachment
    const url = `https://content.airtable.com/v0/${config.baseId}/${recordId}/File/uploadAttachment`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contentType,
        filename,
        file: fileBuffer.toString("base64"),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[remotion-media-mcp] Airtable attachment upload failed (${response.status}): ${errorBody}`
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      `[remotion-media-mcp] Airtable attachment upload error:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

export function detectFileType(
  filename: string
): "image" | "video" | "audio" | "subtitle" | "other" {
  const ext = path.extname(filename).toLowerCase();

  const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".tiff"];
  const videoExts = [".mp4", ".webm", ".mov", ".avi", ".mkv"];
  const audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];
  const subtitleExts = [".srt", ".vtt", ".ass", ".ssa"];

  if (imageExts.includes(ext)) return "image";
  if (videoExts.includes(ext)) return "video";
  if (audioExts.includes(ext)) return "audio";
  if (subtitleExts.includes(ext)) return "subtitle";
  return "other";
}

export function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".srt": "text/srt",
    ".vtt": "text/vtt",
  };
  return mimeMap[ext] || "application/octet-stream";
}
