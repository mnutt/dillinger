import { execFile } from "node:child_process";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderHtmlDocument } from "../lib/export";
import { renderMarkdown } from "../lib/markdown";
import { storedAssetFilename } from "./assets";

const execFileAsync = promisify(execFile);
export const MAX_MARKDOWN_SIZE = 5 * 1024 * 1024;

export interface PublicIdInfo {
  publicId: string;
  hostname: string;
  autoUrl: string;
  isDemoUser: boolean;
}

export interface PublishedInfo extends PublicIdInfo {
  cnameTarget: string;
}

export class PublishError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isPublicIdInfo(value: unknown): value is PublicIdInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as Partial<PublicIdInfo>;
  return (
    typeof info.publicId === "string" && info.publicId.length > 0 &&
    typeof info.hostname === "string" && info.hostname.length > 0 &&
    typeof info.autoUrl === "string" && info.autoUrl.length > 0 &&
    typeof info.isDemoUser === "boolean"
  );
}

export async function publishDocument({
  title,
  markdown,
  sessionId,
  assetsDirectory,
  publishDirectory,
  publicIdHelper,
}: {
  title: unknown;
  markdown: unknown;
  sessionId: string;
  assetsDirectory: string;
  publishDirectory: string;
  publicIdHelper: string;
}): Promise<PublishedInfo> {
  if (typeof title !== "string" || typeof markdown !== "string") {
    throw new PublishError(400, "Title and markdown are required");
  }
  if (Buffer.byteLength(markdown) > MAX_MARKDOWN_SIZE) {
    throw new PublishError(413, "Document is too large to publish");
  }

  try {
    // Creating /var/www enables Sandstorm publishing, so obtain the public ID
    // first and only then make the directory visible to the platform.
    const { stdout } = await execFileAsync(publicIdHelper, ["--json", sessionId], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const publicInfo: unknown = JSON.parse(stdout);
    if (!isPublicIdInfo(publicInfo)) {
      throw new Error("The Sandstorm public ID helper returned invalid metadata");
    }

    const referencedAssets = new Set<string>();
    const rendered = await renderMarkdown(markdown, {
      transformImageUrl(url) {
        const filename = storedAssetFilename(url);
        if (filename) referencedAssets.add(filename);
        return url;
      },
    });
    const html = renderHtmlDocument({ title, html: rendered, styled: true });
    await mkdir(publishDirectory, { recursive: true });
    if (referencedAssets.size > 0) {
      const publishedAssets = join(publishDirectory, "assets");
      await mkdir(publishedAssets, { recursive: true });
      for (const filename of Array.from(referencedAssets)) {
        try {
          await copyFile(
            join(assetsDirectory, filename),
            join(publishedAssets, filename),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new PublishError(400, "An uploaded image is no longer available");
          }
          throw error;
        }
      }
    }
    const target = `${publishDirectory}/index.html`;
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, html, { mode: 0o644 });
    await rename(temporary, target);

    return {
      ...publicInfo,
      cnameTarget: new URL(publicInfo.autoUrl).hostname,
    };
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError(500, "Failed to publish document");
  }
}
