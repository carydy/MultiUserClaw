import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "../config.js";
import type { GatewayRestartable } from "../server.js";
import { asyncHandler } from "../utils.js";

export function settingsRoutes(config: BridgeConfig, manager?: GatewayRestartable): Router {
  const router = Router();
  const configPath = path.join(config.openclawHome, "openclaw.json");

  function readConfig(): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.mkdirSync(config.openclawHome, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  }

  // GET /api/settings/config — read openclaw.json
  router.get("/settings/config", asyncHandler(async (_req, res) => {
    const cfg = readConfig();
    res.json({ config: cfg });
  }));

  // PUT /api/settings/config — merge-update openclaw.json
  router.put("/settings/config", asyncHandler(async (req, res) => {
    const updates = req.body as Record<string, unknown>;
    const existing = readConfig();

    // Shallow merge top-level keys, deep merge for gateway
    for (const [key, value] of Object.entries(updates)) {
      if (key === "gateway" && typeof value === "object" && value !== null &&
          typeof existing.gateway === "object" && existing.gateway !== null) {
        existing.gateway = { ...(existing.gateway as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        existing[key] = value;
      }
    }

    writeConfig(existing);
    res.json({ success: true, config: existing });
  }));

  // POST /api/settings/gateway/restart — restart the gateway process
  router.post("/settings/gateway/restart", asyncHandler(async (_req, res) => {
    if (!manager) {
      res.status(501).json({ detail: "Gateway restart not supported in this mode" });
      return;
    }

    try {
      await manager.restart();
      res.json({ success: true, message: "Gateway restarted" });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  return router;
}
