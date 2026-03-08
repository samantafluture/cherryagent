export interface InspirationUploadParams {
  webhookUrl: string;
  token: string;
  imageBuffer: Buffer;
  mimeType: string;
  filename: string;
  tags?: string[];
  notes?: string;
}

export interface InspirationUploadResult {
  success: boolean;
  id?: string;
  filename?: string;
  error?: string;
}

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function uploadToInspirationBoard(
  params: InspirationUploadParams,
): Promise<InspirationUploadResult> {
  const { webhookUrl, token, imageBuffer, mimeType, filename, tags, notes } =
    params;

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return {
      success: false,
      error: `Invalid mime type: ${mimeType}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
    };
  }

  if (imageBuffer.byteLength > MAX_SIZE_BYTES) {
    return {
      success: false,
      error: `File too large (${(imageBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Max: 10MB`,
    };
  }

  const form = new FormData();
  form.append("file", new Blob([imageBuffer as unknown as ArrayBuffer], { type: mimeType }), filename);

  if (tags?.length) {
    form.append("tags", tags.join(","));
  }
  if (notes) {
    form.append("notes", notes);
  }

  const url = `${webhookUrl}?token=${encodeURIComponent(token)}`;
  const response = await fetch(url, { method: "POST", body: form });
  const json = (await response.json()) as {
    success: boolean;
    data?: { id: string; filename: string };
    error?: string;
  };

  if (!json.success) {
    return { success: false, error: json.error ?? `HTTP ${response.status}` };
  }

  return {
    success: true,
    id: json.data?.id,
    filename: json.data?.filename,
  };
}
