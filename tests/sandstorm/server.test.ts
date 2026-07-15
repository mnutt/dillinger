// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandstormServer } from "@/sandstorm/server";

const grainState = {
  version: 1,
  document: {
    id: "doc-1",
    title: "Static grain",
    body: "# Fast",
    createdAt: "2026-07-14T00:00:00.000Z",
  },
};

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sotG2UAAAAASUVORK5CYII=",
  "base64",
);

describe("Sandstorm static server", () => {
  let directory: string;
  let baseUrl: string;
  let server: ReturnType<typeof createSandstormServer>;
  let statePath: string;
  let assetsDirectory: string;
  let publishDirectory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dillinger-static-server-"));
    const staticRoot = join(directory, "standalone");
    const indexPath = join(staticRoot, ".next/server/app/index.html");
    statePath = join(directory, "var/dillinger/state.json");
    assetsDirectory = join(directory, "var/dillinger/assets");
    publishDirectory = join(directory, "var/www");
    const publicIdHelper = join(directory, "get-public-id");

    await mkdir(join(staticRoot, ".next/static/chunks"), { recursive: true });
    await mkdir(join(staticRoot, "public"), { recursive: true });
    await mkdir(join(staticRoot, ".next/server/app"), { recursive: true });
    await writeFile(indexPath, "<!doctype html><title>Static Dillinger</title>");
    await writeFile(join(staticRoot, ".next/static/chunks/app.js"), "window.app = true;");
    await writeFile(
      join(staticRoot, ".next/static/chunks/app.js.gz"),
      gzipSync("window.app = true;", { level: 9 }),
    );
    await writeFile(join(staticRoot, "public/site.webmanifest"), "{}");
    await writeFile(
      publicIdHelper,
      `#!/bin/sh
printf '%s\\n' '{"publicId":"public-id","hostname":"example.test","autoUrl":"https://public-id.example.test","isDemoUser":false}'
`,
      { mode: 0o755 },
    );

    server = createSandstormServer({
      staticRoot,
      indexPath,
      statePath,
      assetsDirectory,
      publishDirectory,
      publicIdHelper,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it("serves the generated editor and immutable Next assets", async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Static Dillinger");

    const asset = await fetch(`${baseUrl}/_next/static/chunks/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("window.app = true;");

    const compressed = await fetch(`${baseUrl}/_next/static/chunks/app.js`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
    expect(await compressed.text()).toBe("window.app = true;");
  });

  it("persists one grain document and enforces edit permission", async () => {
    const denied = await fetch(`${baseUrl}/api/sandstorm/state`, {
      method: "PUT",
      body: JSON.stringify(grainState),
    });
    expect(denied.status).toBe(403);

    const saved = await fetch(`${baseUrl}/api/sandstorm/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Sandstorm-Permissions": "edit",
      },
      body: JSON.stringify(grainState),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(grainState);

    const loaded = await fetch(`${baseUrl}/api/sandstorm/state`);
    await expect(loaded.json()).resolves.toEqual({ exists: true, state: grainState });
  });

  it("publishes HTML without loading the Next server", async () => {
    const formData = new FormData();
    formData.append("image", new File([PNG_BYTES], "pixel.png", { type: "image/png" }));
    const upload = await fetch(`${baseUrl}/api/upload/image`, {
      method: "POST",
      headers: { "X-Sandstorm-Permissions": "edit" },
      body: formData,
    });
    const uploaded = await upload.json() as { url: string };

    const response = await fetch(`${baseUrl}/api/sandstorm/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sandstorm-Permissions": "edit",
        "X-Sandstorm-Session-Id": "session-id",
      },
      body: JSON.stringify({
        title: "Fast <grain>",
        markdown: `# Published\n\n![pixel](${uploaded.url})`,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      publicId: "public-id",
      cnameTarget: "public-id.example.test",
    });
    const published = await readFile(join(publishDirectory, "index.html"), "utf8");
    expect(published).toContain("Published</h1>");
    expect(published).toContain("<title>Fast &lt;grain&gt;</title>");
    expect(published).toContain(`src="${uploaded.url}"`);
    await expect(readFile(join(publishDirectory, uploaded.url))).resolves.toEqual(PNG_BYTES);
  });

  it("stores uploaded images in the grain and serves immutable references", async () => {
    const deniedData = new FormData();
    deniedData.append("image", new File([PNG_BYTES], "pixel.png", { type: "image/png" }));
    const denied = await fetch(`${baseUrl}/api/upload/image`, {
      method: "POST",
      body: deniedData,
    });
    expect(denied.status).toBe(403);

    const formData = new FormData();
    formData.append("image", new File([PNG_BYTES], "pixel.png", { type: "image/png" }));
    const response = await fetch(`${baseUrl}/api/upload/image`, {
      method: "POST",
      headers: { "X-Sandstorm-Permissions": "edit" },
      body: formData,
    });

    expect(response.status).toBe(200);
    const uploaded = await response.json() as { url: string; markdown: string };
    expect(uploaded.url).toMatch(/^\/assets\/[a-f0-9]{64}\.png$/);
    expect(uploaded.markdown).toBe(`![pixel](${uploaded.url})`);

    const asset = await fetch(`${baseUrl}${uploaded.url}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("image/png");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("keeps HTML export available in the small server", async () => {
    const response = await fetch(`${baseUrl}/api/export/html`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Export", markdown: "**bold**", styled: true }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("Export.html");
    expect(await response.text()).toContain("<strong>bold</strong>");
  });
});
