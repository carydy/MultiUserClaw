import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Wrap async route handlers to catch errors and forward to Express error handler.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Convert nanobot session_id format (e.g. "web:default") to openclaw session key.
 * Nanobot uses "web:<name>" format; openclaw uses "direct:<name>" or just the key.
 */
export function toOpenclawSessionKey(nanobotSessionId: string): string {
  // Nanobot convention: "web:default", "web:abc123"
  // OpenClaw convention: "direct:web:<name>" or we can just pass through
  // For simplicity, pass through as-is — openclaw accepts arbitrary session keys
  return nanobotSessionId;
}

/**
 * Convert openclaw session key back to nanobot format.
 */
export function toNanobotSessionId(openclawKey: string): string {
  return openclawKey;
}

/**
 * Extract text content from openclaw message content array.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: Record<string, unknown>) => block.type === "text")
      .map((block: Record<string, unknown>) => block.text)
      .join("");
  }
  return "";
}

/**
 * Generate a unique file ID (12 hex chars).
 */
export function generateFileId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Sanitize path to prevent directory traversal.
 */
export function sanitizePath(inputPath: string, basePath: string): string | null {
  const resolved = path.resolve(basePath, inputPath);
  if (!resolved.startsWith(basePath)) {
    return null;
  }
  return resolved;
}
