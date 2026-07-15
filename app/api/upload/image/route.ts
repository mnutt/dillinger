export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { AssetError, storeImage } from "@/sandstorm/assets";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
function canEdit(request: NextRequest): boolean {
  return (request.headers.get("x-sandstorm-permissions") || "")
    .split(",")
    .map((permission) => permission.trim())
    .includes("edit");
}

export async function POST(request: NextRequest) {
  try {
    if (process.env.SANDSTORM === "1" && !canEdit(request)) {
      return NextResponse.json({ error: "Edit permission required" }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("image") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Supported: JPEG, PNG, GIF, WebP, SVG" },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large. Maximum size is 5MB" },
        { status: 400 }
      );
    }

    // Read the validated image once. Sandstorm stores these bytes durably;
    // the hosted app retains its existing self-contained data URL behavior.
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (process.env.SANDSTORM === "1") {
      return NextResponse.json(await storeImage({
        bytes: buffer,
        type: file.type,
        filename: file.name,
        assetsDirectory: process.env.SANDSTORM_ASSETS_DIRECTORY || "/var/dillinger/assets",
      }));
    }

    const base64 = buffer.toString("base64");
    const dataUrl = `data:${file.type};base64,${base64}`;

    // Get filename without extension for alt text
    const altText = file.name.replace(/\.[^/.]+$/, "");

    // Return markdown syntax for the image
    const markdown = `![${altText}](${dataUrl})`;

    return NextResponse.json({
      success: true,
      url: dataUrl,
      markdown,
      filename: file.name,
      size: file.size,
      type: file.type,
    });
  } catch (error) {
    console.error("Image upload error:", error);
    const status = error instanceof AssetError ? error.status : 500;
    const message = error instanceof AssetError ? error.message : "Failed to process image";
    return NextResponse.json({ error: message }, { status });
  }
}
