export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { publishDocument, PublishError } from "@/sandstorm/publish";

const PUBLISH_DIRECTORY = process.env.SANDSTORM_PUBLISH_DIRECTORY || "/var/www";
const ASSETS_DIRECTORY = process.env.SANDSTORM_ASSETS_DIRECTORY || "/var/dillinger/assets";
const PUBLIC_ID_HELPER =
  process.env.SANDSTORM_GET_PUBLIC_ID_PATH ||
  "/opt/app/.sandstorm/utils/get-public-id";

function canEdit(request: NextRequest): boolean {
  return (request.headers.get("x-sandstorm-permissions") || "")
    .split(",")
    .map((permission) => permission.trim())
    .includes("edit");
}

export async function POST(request: NextRequest) {
  if (process.env.SANDSTORM !== "1") {
    return NextResponse.json({ error: "Not available outside Sandstorm" }, { status: 404 });
  }
  if (!canEdit(request)) {
    return NextResponse.json({ error: "Edit permission required" }, { status: 403 });
  }

  const sessionId = request.headers.get("x-sandstorm-session-id");
  if (!sessionId) {
    return NextResponse.json({ error: "Sandstorm session is unavailable" }, { status: 400 });
  }

  try {
    const body: unknown = await request.json();
    const { title, markdown } = body as { title?: unknown; markdown?: unknown };
    return NextResponse.json(await publishDocument({
      title,
      markdown,
      sessionId,
      assetsDirectory: ASSETS_DIRECTORY,
      publishDirectory: PUBLISH_DIRECTORY,
      publicIdHelper: PUBLIC_ID_HELPER,
    }));
  } catch (error) {
    console.error("Failed to publish Sandstorm document:", error);
    const publishError = error instanceof PublishError
      ? error
      : new PublishError(500, "Failed to publish document");
    return NextResponse.json({ error: publishError.message }, { status: publishError.status });
  }
}
