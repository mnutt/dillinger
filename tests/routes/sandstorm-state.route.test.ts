// @vitest-environment node

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  version: 1,
  document: {
    id: "doc-1",
    title: "Sandstorm.md",
    body: "# Durable",
    createdAt: "2026-07-14T00:00:00.000Z",
  },
};

describe("/api/sandstorm/state", () => {
  let statePath: string;

  beforeEach(async () => {
    statePath = join(await mkdtemp(join(tmpdir(), "dillinger-state-")), "state.json");
    vi.stubEnv("SANDSTORM", "1");
    vi.stubEnv("SANDSTORM_STATE_PATH", statePath);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty result for a new grain", async () => {
    const { GET } = await import("@/app/api/sandstorm/state/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: false });
  });

  it("requires Sandstorm edit permission for writes", async () => {
    const { PUT } = await import("@/app/api/sandstorm/state/route");
    const response = await PUT(new Request("http://sandbox/api/sandstorm/state", {
      method: "PUT",
      body: JSON.stringify(state),
    }) as never);

    expect(response.status).toBe(403);
  });

  it("atomically persists and reloads grain state", async () => {
    const { GET, PUT } = await import("@/app/api/sandstorm/state/route");
    const response = await PUT(new Request("http://sandbox/api/sandstorm/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Sandstorm-Permissions": "edit",
      },
      body: JSON.stringify(state),
    }) as never);

    expect(response.status).toBe(200);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(state);

    const loaded = await GET();
    await expect(loaded.json()).resolves.toEqual({ exists: true, state });
  });

  it("is not exposed by non-Sandstorm deployments", async () => {
    vi.stubEnv("SANDSTORM", "0");
    vi.resetModules();
    const { GET } = await import("@/app/api/sandstorm/state/route");

    expect((await GET()).status).toBe(404);
  });
});
