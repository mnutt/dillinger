// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /api/sandstorm/publish", () => {
  let publishDirectory: string;
  let assetsDirectory: string;
  let helperPath: string;

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), "dillinger-publish-"));
    publishDirectory = join(directory, "www");
    assetsDirectory = join(directory, "assets");
    helperPath = join(directory, "get-public-id");
    await writeFile(
      helperPath,
      `#!/bin/sh
printf '%s\\n' '{"publicId":"public-id","hostname":"local.sandstorm.io","autoUrl":"https://public-id.local.sandstorm.io","isDemoUser":false}'
`,
      { mode: 0o755 }
    );

    vi.stubEnv("SANDSTORM", "1");
    vi.stubEnv("SANDSTORM_PUBLISH_DIRECTORY", publishDirectory);
    vi.stubEnv("SANDSTORM_ASSETS_DIRECTORY", assetsDirectory);
    vi.stubEnv("SANDSTORM_GET_PUBLIC_ID_PATH", helperPath);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires the edit permission", async () => {
    const { POST } = await import("@/app/api/sandstorm/publish/route");
    const response = await POST(new Request("http://sandbox/api/sandstorm/publish", {
      method: "POST",
      body: JSON.stringify({ title: "Document", markdown: "# Hello" }),
    }) as never);

    expect(response.status).toBe(403);
  });

  it("publishes static HTML and returns Sandstorm URL metadata", async () => {
    const assetFilename = `${"a".repeat(64)}.png`;
    await mkdir(assetsDirectory, { recursive: true });
    await writeFile(join(assetsDirectory, assetFilename), "image bytes");
    const { POST } = await import("@/app/api/sandstorm/publish/route");
    const response = await POST(new Request("http://sandbox/api/sandstorm/publish", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sandstorm-Permissions": "edit",
        "X-Sandstorm-Session-Id": "session-id",
      },
      body: JSON.stringify({
        title: "A <Document>",
        markdown: `# Hello Sandstorm\n\n![image](/assets/${assetFilename})`,
      }),
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      publicId: "public-id",
      autoUrl: "https://public-id.local.sandstorm.io",
      cnameTarget: "public-id.local.sandstorm.io",
    });

    const html = await readFile(join(publishDirectory, "index.html"), "utf8");
    expect(html).toContain("Hello Sandstorm</h1>");
    expect(html).toContain("<title>A &lt;Document&gt;</title>");
    expect(html).toContain(`src="/assets/${assetFilename}"`);
    await expect(readFile(join(publishDirectory, "assets", assetFilename), "utf8"))
      .resolves.toBe("image bytes");
  });

  it("is not exposed outside Sandstorm", async () => {
    vi.stubEnv("SANDSTORM", "0");
    vi.resetModules();
    const { POST } = await import("@/app/api/sandstorm/publish/route");

    const response = await POST(new Request("http://localhost/api/sandstorm/publish", {
      method: "POST",
    }) as never);
    expect(response.status).toBe(404);
  });
});
