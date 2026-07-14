export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import {
  readSandstormState,
  StateError,
  writeSandstormState,
} from "@/sandstorm/state";

const STATE_PATH = process.env.SANDSTORM_STATE_PATH || "/var/dillinger/state.json";

function isSandstorm(): boolean {
  return process.env.SANDSTORM === "1";
}

function canEdit(request: NextRequest): boolean {
  return (request.headers.get("x-sandstorm-permissions") || "")
    .split(",")
    .map((permission) => permission.trim())
    .includes("edit");
}

export async function GET() {
  if (!isSandstorm()) {
    return NextResponse.json({ error: "Not available outside Sandstorm" }, { status: 404 });
  }

  try {
    return NextResponse.json(await readSandstormState(STATE_PATH));
  } catch (error) {
    console.error("Failed to read Sandstorm grain state:", error);
    const stateError = error instanceof StateError
      ? error
      : new StateError(500, "Failed to read grain state");
    return NextResponse.json({ error: stateError.message }, { status: stateError.status });
  }
}

export async function PUT(request: NextRequest) {
  if (!isSandstorm()) {
    return NextResponse.json({ error: "Not available outside Sandstorm" }, { status: 404 });
  }
  if (!canEdit(request)) {
    return NextResponse.json({ error: "Edit permission required" }, { status: 403 });
  }

  try {
    await writeSandstormState(STATE_PATH, await request.text());
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to write Sandstorm grain state:", error);
    const stateError = error instanceof StateError
      ? error
      : new StateError(500, "Failed to write grain state");
    return NextResponse.json({ error: stateError.message }, { status: stateError.status });
  }
}
