import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import mime from "mime-types";
import type { BridgeConfig } from "../config.js";
import { asyncHandler, sanitizePath } from "../utils.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export function workspaceRoutes(config: BridgeConfig): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: MAX_FILE_SIZE } });

  // GET /api/workspace/browse
  router.get("/workspace/browse", asyncHandler(async (req, res) => {
    const relPath = (req.query.path as string) || "";
    const absPath = sanitizePath(relPath, config.workspacePath);

    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      res.status(400).json({ detail: "Path is not a directory" });
      return;
    }

    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."));

    const items = entries.map((e) => {
      const itemPath = path.join(absPath, e.name);
      const stat = fs.statSync(itemPath);
      const itemRelPath = path.relative(config.workspacePath, itemPath);

      if (e.isDirectory()) {
        return {
          name: e.name,
          path: itemRelPath,
          type: "directory" as const,
          size: null,
          modified: stat.mtime.toISOString(),
        };
      } else {
        return {
          name: e.name,
          path: itemRelPath,
          type: "file" as const,
          size: stat.size,
          content_type: mime.lookup(e.name) || "application/octet-stream",
          modified: stat.mtime.toISOString(),
        };
      }
    });

    // Sort: directories first, then files, each alpha-sorted
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    res.json({ path: relPath, items });
  }));

  // GET /api/workspace/download
  router.get("/workspace/download", asyncHandler(async (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, config.workspacePath);
    if (!absPath || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    const fileName = path.basename(absPath);
    const contentType = mime.lookup(fileName) || "application/octet-stream";
    const isImage = contentType.startsWith("image/");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", isImage ? "inline" : `attachment; filename="${fileName}"`);
    fs.createReadStream(absPath).pipe(res);
  }));

  // POST /api/workspace/upload
  router.post("/workspace/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file || !file.originalname) {
      res.status(400).json({ detail: "No filename provided" });
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      res.status(413).json({ detail: "File too large (max 50MB)" });
      return;
    }

    const targetDir = (req.body.path as string) || "";
    const absDirPath = sanitizePath(targetDir, config.workspacePath);
    if (!absDirPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    fs.mkdirSync(absDirPath, { recursive: true });
    const filePath = path.join(absDirPath, file.originalname);

    // Validate filename doesn't contain path separators
    if (file.originalname.includes("/") || file.originalname.includes("\\")) {
      res.status(400).json({ detail: "Invalid filename" });
      return;
    }

    fs.writeFileSync(filePath, file.buffer);
    const stat = fs.statSync(filePath);
    const relPath = path.relative(config.workspacePath, filePath);

    res.json({
      name: file.originalname,
      path: relPath,
      type: "file",
      size: stat.size,
      content_type: file.mimetype || mime.lookup(file.originalname) || "application/octet-stream",
      modified: stat.mtime.toISOString(),
    });
  }));

  // DELETE /api/workspace/delete
  router.delete("/workspace/delete", asyncHandler(async (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, config.workspacePath);
    if (!absPath || !fs.existsSync(absPath)) {
      res.status(404).json({ detail: "Path not found" });
      return;
    }

    fs.rmSync(absPath, { recursive: true });
    res.json({ ok: true });
  }));

  // POST /api/workspace/mkdir
  router.post("/workspace/mkdir", asyncHandler(async (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, config.workspacePath);
    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    fs.mkdirSync(absPath, { recursive: true });
    const dirName = path.basename(absPath);

    res.json({
      name: dirName,
      path: relPath,
      type: "directory",
    });
  }));

  return router;
}
