import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Document } from "../lib/types";

export const MAX_STATE_SIZE = 10 * 1024 * 1024;

export interface SandstormState {
  version: 1;
  document: Document;
}

export class StateError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isDocument(value: unknown): value is Document {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<Document>;
  return (
    typeof document.id === "string" &&
    typeof document.title === "string" &&
    typeof document.body === "string" &&
    typeof document.createdAt === "string"
  );
}

export function isSandstormState(value: unknown): value is SandstormState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SandstormState>;
  return state.version === 1 && isDocument(state.document);
}

export async function readSandstormState(statePath: string): Promise<
  | { exists: false }
  | { exists: true; state: SandstormState }
> {
  try {
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isSandstormState(state)) {
      throw new StateError(500, "Stored grain state is invalid");
    }
    return { exists: true, state };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    if (error instanceof StateError) throw error;
    throw new StateError(500, "Failed to read grain state");
  }
}

export async function writeSandstormState(
  statePath: string,
  body: string,
): Promise<void> {
  if (Buffer.byteLength(body) > MAX_STATE_SIZE) {
    throw new StateError(413, "Grain state is too large");
  }

  let state: unknown;
  try {
    state = JSON.parse(body);
  } catch {
    throw new StateError(400, "Invalid JSON");
  }

  if (!isSandstormState(state)) {
    throw new StateError(400, "Invalid grain state");
  }

  try {
    await mkdir(dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporaryPath, statePath);
  } catch {
    throw new StateError(500, "Failed to write grain state");
  }
}
