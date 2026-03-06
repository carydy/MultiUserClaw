import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import mime from "mime-types";
import type { BridgeConfig } from "../config.js";
import { asyncHandler, generateFileId } from "../utils.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

interface FileMetadata {
  file_id: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
  session_id: string;
}

export function filesRoutes(config: BridgeConfig): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: MAX_FILE_SIZE } });

  // POST /api/files/upload
  router.post("/files/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file || !file.originalname) {
      res.status(400).json({ detail: "No filename provided" });
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      res.status(413).json({ detail: "File too large (max 50MB)" });
      return;
    }

    const sessionId = (req.body.session_id as string) || "web:default";
    const fileId = generateFileId();
    const fileDir = path.join(config.uploadsPath, fileId);
    fs.mkdirSync(fileDir, { recursive: true });

    // Write file
    const filePath = path.join(fileDir, file.originalname);
    fs.writeFileSync(filePath, file.buffer);

    // Write metadata
    const contentType = file.mimetype || mime.lookup(file.originalname) || "application/octet-stream";
    const metadata: FileMetadata = {
      file_id: fileId,
      name: file.originalname,
      content_type: contentType,
      size: file.size,
      created_at: new Date().toISOString(),
      session_id: sessionId,
    };
    fs.writeFileSync(path.join(fileDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    res.json({ ...metadata, url: `/api/files/${fileId}` });
  }));

  // GET /api/files
  router.get("/files", asyncHandler(async (req, res) => {
    const sessionFilter = req.query.session_id as string | undefined;
    const files: FileMetadata[] = [];

    if (!fs.existsSync(config.uploadsPath)) {
      res.json(files);
      return;
    }

    for (const dir of fs.readdirSync(config.uploadsPath)) {
      const metaPath = path.join(config.uploadsPath, dir, "metadata.json");
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta: FileMetadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (sessionFilter && meta.session_id !== sessionFilter) continue;
        files.push(meta);
      } catch {
        continue;
      }
    }

    res.json(files);
  }));

  // GET /api/files/:file_id
  router.get("/files/:file_id", asyncHandler(async (req, res) => {
    const fileId = req.params.file_id;
    const fileDir = path.join(config.uploadsPath, fileId);
    const metaPath = path.join(fileDir, "metadata.json");

    if (!fs.existsSync(metaPath)) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    const meta: FileMetadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const filePath = path.join(fileDir, meta.name);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    const isImage = meta.content_type.startsWith("image/");
    res.setHeader("Content-Type", meta.content_type);
    res.setHeader("Content-Disposition", isImage ? "inline" : `attachment; filename="${meta.name}"`);
    fs.createReadStream(filePath).pipe(res);
  }));

  // DELETE /api/files/:file_id
  router.delete("/files/:file_id", asyncHandler(async (req, res) => {
    const fileId = req.params.file_id;
    const fileDir = path.join(config.uploadsPath, fileId);

    if (!fs.existsSync(fileDir)) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    fs.rmSync(fileDir, { recursive: true });
    res.json({ ok: true });
  }));

  return router;
}
