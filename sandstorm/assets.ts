import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const STORED_ASSET_URL = /^\/assets\/([a-f0-9]{64}\.(?:jpg|png|gif|webp|svg))$/;

export interface StoredImage {
  success: true;
  url: string;
  markdown: string;
  filename: string;
  size: number;
  type: string;
}

export class AssetError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function imageAltText(filename: string): string {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function storedAssetFilename(url: string): string | null {
  return STORED_ASSET_URL.exec(url)?.[1] || null;
}

export async function storeImage({
  bytes,
  type,
  filename,
  assetsDirectory,
}: {
  bytes: Buffer;
  type: string;
  filename: string;
  assetsDirectory: string;
}): Promise<StoredImage> {
  const extension = IMAGE_EXTENSIONS[type];
  if (!extension) {
    throw new AssetError(
      400,
      "Invalid file type. Supported: JPEG, PNG, GIF, WebP, SVG",
    );
  }
  if (bytes.length > MAX_IMAGE_SIZE) {
    throw new AssetError(400, "File too large. Maximum size is 5MB");
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  const assetFilename = `${digest}.${extension}`;
  const url = `/assets/${assetFilename}`;

  try {
    await mkdir(assetsDirectory, { recursive: true });
    const target = join(assetsDirectory, assetFilename);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o644 });
    await rename(temporary, target);
  } catch {
    throw new AssetError(500, "Failed to store image");
  }

  return {
    success: true,
    url,
    markdown: `![${imageAltText(filename)}](${url})`,
    filename,
    size: bytes.length,
    type,
  };
}
