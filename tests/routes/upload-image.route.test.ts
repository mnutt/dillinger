// @vitest-environment node

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as uploadImage } from "@/app/api/upload/image/route";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sotG2UAAAAASUVORK5CYII=",
  "base64"
);

describe("POST /api/upload/image", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns markdown for a valid image upload", async () => {
    const formData = new FormData();
    formData.append(
      "image",
      new File([PNG_BYTES], "pixel.png", { type: "image/png" })
    );

    const response = await uploadImage(
      new Request("http://localhost/api/upload/image", {
        method: "POST",
        body: formData,
      }) as never
    );

    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.markdown).toContain("![pixel]");
    expect(json.url).toContain("data:image/png;base64,");
  });

  it("rejects invalid file types", async () => {
    const formData = new FormData();
    formData.append(
      "image",
      new File(["not an image"], "notes.txt", { type: "text/plain" })
    );

    const response = await uploadImage(
      new Request("http://localhost/api/upload/image", {
        method: "POST",
        body: formData,
      }) as never
    );

    expect(response.status).toBe(400);
  });

  it("rejects oversized uploads", async () => {
    const formData = new FormData();
    formData.append(
      "image",
      new File([Buffer.alloc(5 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      })
    );

    const response = await uploadImage(
      new Request("http://localhost/api/upload/image", {
        method: "POST",
        body: formData,
      }) as never
    );

    expect(response.status).toBe(400);
  });

  it("stores a reference in grain storage when running under Sandstorm", async () => {
    const assetsDirectory = await mkdtemp(join(tmpdir(), "dillinger-assets-"));
    vi.stubEnv("SANDSTORM", "1");
    vi.stubEnv("SANDSTORM_ASSETS_DIRECTORY", assetsDirectory);
    const formData = new FormData();
    formData.append(
      "image",
      new File([PNG_BYTES], "pixel.png", { type: "image/png" }),
    );

    const response = await uploadImage(
      new Request("http://localhost/api/upload/image", {
        method: "POST",
        headers: { "X-Sandstorm-Permissions": "edit" },
        body: formData,
      }) as never,
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.url).toMatch(/^\/assets\/[a-f0-9]{64}\.png$/);
    expect(json.markdown).toBe(`![pixel](${json.url})`);
    await expect(readFile(join(assetsDirectory, json.url.split("/").pop())))
      .resolves.toEqual(PNG_BYTES);
  });
});
