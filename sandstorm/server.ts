import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { getExportFilename, renderHtmlDocument } from "../lib/export";
import { renderMarkdown } from "../lib/markdown";
import { publishDocument, PublishError } from "./publish";
import { readSandstormState, StateError, writeSandstormState } from "./state";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_REQUEST_SIZE = 11 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": JSON_CONTENT_TYPE,
  ".map": JSON_CONTENT_TYPE,
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface SandstormServerOptions {
  staticRoot: string;
  indexPath: string;
  statePath: string;
  publishDirectory: string;
  publicIdHelper: string;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function defaultOptions(): SandstormServerOptions {
  const staticRoot = process.env.SANDSTORM_STATIC_ROOT ||
    "/opt/app/.next/sandstorm-package";
  return {
    staticRoot,
    indexPath: process.env.SANDSTORM_INDEX_PATH ||
      `${staticRoot}/index.html`,
    statePath: process.env.SANDSTORM_STATE_PATH || "/var/dillinger/state.json",
    publishDirectory: process.env.SANDSTORM_PUBLISH_DIRECTORY || "/var/www",
    publicIdHelper: process.env.SANDSTORM_GET_PUBLIC_ID_PATH ||
      "/opt/app/.sandstorm/utils/get-public-id",
  };
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function text(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function canEdit(request: IncomingMessage): boolean {
  const permissions = request.headers["x-sandstorm-permissions"];
  const value = Array.isArray(permissions) ? permissions.join(",") : permissions || "";
  return value.split(",").some((permission) => permission.trim() === "edit");
}

function requireEdit(request: IncomingMessage): void {
  if (!canEdit(request)) {
    throw new HttpError(403, "Edit permission required");
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(
  request: IncomingMessage,
  maximum = MAX_REQUEST_SIZE,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) {
      throw new HttpError(413, "Request is too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await readBody(request)).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON object required");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON");
  }
}

function contentDisposition(filename: string): string {
  return `attachment; filename="${filename.replaceAll('"', "")}"`;
}

async function handleState(
  request: IncomingMessage,
  response: ServerResponse,
  options: SandstormServerOptions,
): Promise<void> {
  if (request.method === "GET") {
    json(response, 200, await readSandstormState(options.statePath));
    return;
  }
  if (request.method === "PUT") {
    requireEdit(request);
    await writeSandstormState(
      options.statePath,
      (await readBody(request, MAX_REQUEST_SIZE)).toString("utf8"),
    );
    json(response, 200, { success: true });
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function handlePublish(
  request: IncomingMessage,
  response: ServerResponse,
  options: SandstormServerOptions,
): Promise<void> {
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  requireEdit(request);
  const sessionId = header(request, "x-sandstorm-session-id");
  if (!sessionId) throw new HttpError(400, "Sandstorm session is unavailable");
  const body = await readJson(request);
  json(response, 200, await publishDocument({
    title: body.title,
    markdown: body.markdown,
    sessionId,
    publishDirectory: options.publishDirectory,
    publicIdHelper: options.publicIdHelper,
  }));
}

async function handleMarkdownExport(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (typeof body.markdown !== "string" || !body.markdown) {
    throw new HttpError(400, "Markdown content is required");
  }
  const filename = getExportFilename(
    typeof body.title === "string" ? body.title : undefined,
    "md",
  );
  text(response, 200, body.markdown, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": contentDisposition(filename),
  });
}

async function handleHtmlExport(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (typeof body.markdown !== "string" || !body.markdown) {
    throw new HttpError(400, "Markdown content is required");
  }
  const title = typeof body.title === "string" ? body.title : undefined;
  const html = renderHtmlDocument({
    title,
    html: await renderMarkdown(body.markdown),
    styled: body.styled === true,
  });
  text(response, 200, html, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": contentDisposition(getExportFilename(title, "html")),
  });
}

async function handlePdfExport(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (typeof body.markdown !== "string" || !body.markdown) {
    throw new HttpError(400, "Markdown content is required");
  }
  const title = typeof body.title === "string" ? body.title : undefined;
  const { renderPdfBuffer } = await import("../lib/pdf");
  const pdf = await renderPdfBuffer({ markdown: body.markdown, title });
  text(response, 200, pdf, {
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition(getExportFilename(title, "pdf")),
  });
}

async function handleHtmlImport(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (typeof body.html !== "string" || !body.html.trim()) {
    throw new HttpError(400, "HTML content is required");
  }
  const { default: TurndownService } = await import("turndown");
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  turndown.addRule("strikethrough", {
    filter: ["del", "s", "strike"],
    replacement(content) {
      return `~~${content}~~`;
    },
  });
  json(response, 200, { markdown: turndown.turndown(body.html).trim() });
}

async function handleImageUpload(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request, MAX_IMAGE_SIZE + 1024 * 1024);
  const contentType = header(request, "content-type");
  if (!contentType) throw new HttpError(400, "No image provided");

  const webRequest = new Request("http://sandstorm.invalid/api/upload/image", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: body as unknown as BodyInit,
  });
  const formData = await webRequest.formData();
  const file = formData.get("image");
  if (!file || typeof file === "string") {
    throw new HttpError(400, "No image provided");
  }
  if (!IMAGE_TYPES.has(file.type)) {
    throw new HttpError(400, "Invalid file type. Supported: JPEG, PNG, GIF, WebP, SVG");
  }
  if (file.size > MAX_IMAGE_SIZE) {
    throw new HttpError(400, "File too large. Maximum size is 5MB");
  }

  const filename = "name" in file && typeof file.name === "string"
    ? file.name
    : "image";
  const dataUrl = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
  const altText = filename.replace(/\.[^/.]+$/, "");
  json(response, 200, {
    success: true,
    url: dataUrl,
    markdown: `![${altText}](${dataUrl})`,
    filename,
    size: file.size,
    type: file.type,
  });
}

async function handleApi(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: SandstormServerOptions,
): Promise<void> {
  if (pathname === "/api/sandstorm/state") {
    await handleState(request, response, options);
  } else if (pathname === "/api/sandstorm/publish") {
    await handlePublish(request, response, options);
  } else if (request.method !== "POST") {
    throw new HttpError(405, "Method not allowed");
  } else if (pathname === "/api/export/markdown") {
    await handleMarkdownExport(request, response);
  } else if (pathname === "/api/export/html") {
    await handleHtmlExport(request, response);
  } else if (pathname === "/api/export/pdf") {
    await handlePdfExport(request, response);
  } else if (pathname === "/api/import/html-to-markdown") {
    await handleHtmlImport(request, response);
  } else if (pathname === "/api/upload/image") {
    await handleImageUpload(request, response);
  } else {
    throw new HttpError(404, "Not found");
  }
}

function safePath(root: string, relativePath: string): string | null {
  const candidate = resolve(root, relativePath);
  const normalizedRoot = resolve(root);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${sep}`)
    ? candidate
    : null;
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  immutable: boolean,
): Promise<boolean> {
  try {
    let selectedPath = path;
    let info = await stat(path);
    if (!info.isFile()) return false;
    let servesGzip = false;
    if (/\bgzip\b/i.test(header(request, "accept-encoding") || "")) {
      try {
        const gzipInfo = await stat(`${path}.gz`);
        if (gzipInfo.isFile()) {
          selectedPath = `${path}.gz`;
          info = gzipInfo;
          servesGzip = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...(servesGzip
        ? { "Content-Encoding": "gzip", "Vary": "Accept-Encoding" }
        : {}),
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(selectedPath).pipe(response);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function handleStatic(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: SandstormServerOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "Method not allowed");
  }
  if (pathname === "/" || pathname === "/index.html") {
    if (await serveFile(request, response, options.indexPath, false)) return;
    throw new HttpError(500, "Static editor build is missing");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid path");
  }

  const isNextAsset = decoded.startsWith("/_next/static/");
  const relativePath = isNextAsset
    ? decoded.slice("/_next/static/".length)
    : decoded.replace(/^\/+/, "");
  const root = isNextAsset
    ? `${options.staticRoot}/.next/static`
    : `${options.staticRoot}/public`;
  const filePath = safePath(root, relativePath);
  if (!filePath || !(await serveFile(request, response, filePath, isNextAsset))) {
    throw new HttpError(404, "Not found");
  }
}

export function createSandstormServer(
  overrides: Partial<SandstormServerOptions> = {},
) {
  const options = { ...defaultOptions(), ...overrides };
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://sandstorm.invalid").pathname;
      if (pathname.startsWith("/api/")) {
        await handleApi(pathname, request, response, options);
      } else {
        await handleStatic(pathname, request, response, options);
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const known = error instanceof HttpError ||
        error instanceof StateError ||
        error instanceof PublishError;
      const status = known ? error.status : 500;
      const message = known ? error.message : "Internal server error";
      if (!known) console.error("Sandstorm server request failed:", error);
      json(response, status, { error: message });
    }
  });
}

if (process.env.NODE_ENV !== "test" && require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8000", 10);
  const hostname = process.env.HOSTNAME || "127.0.0.1";
  const started = process.hrtime.bigint();
  createSandstormServer().listen(port, hostname, () => {
    const milliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
    console.log(`Dillinger Sandstorm server ready in ${milliseconds.toFixed(1)}ms`);
  });
}
