import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeConfig } from "../config.js";
import { asyncHandler } from "../utils.js";

interface PluginInfo {
  name: string;
  description: string;
  source: string;
  agents: Array<{ name: string; description: string; model: string | null }>;
  commands: Array<{ name: string; description: string; argument_hint: string | null }>;
  skills: string[];
}

function scanPlugin(pluginDir: string, pluginName: string, source: string): PluginInfo | null {
  // Try plugin.json or .claude-plugin/plugin.json
  let pluginJsonPath = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    pluginJsonPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  }

  let description = "";
  if (fs.existsSync(pluginJsonPath)) {
    try {
      const pj = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
      description = pj.description || "";
    } catch { /* ignore */ }
  }

  // Scan agents
  const agents: PluginInfo["agents"] = [];
  const agentsDir = path.join(pluginDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(agentsDir, file), "utf-8");
      let name = path.basename(file, ".md");
      let desc = "";
      let model: string | null = null;
      let inFm = false;

      for (const line of content.split("\n")) {
        if (line.trim() === "---") { inFm = !inFm; continue; }
        if (inFm) {
          const nm = line.match(/^name:\s*(.+)/);
          if (nm) name = nm[1].trim();
          const dm = line.match(/^description:\s*(.+)/);
          if (dm) desc = dm[1].trim();
          const mm = line.match(/^model:\s*(.+)/);
          if (mm) model = mm[1].trim();
        }
      }

      agents.push({ name, description: desc, model });
    }
  }

  // Scan commands
  const commands: PluginInfo["commands"] = [];
  const cmdDir = path.join(pluginDir, "commands");
  if (fs.existsSync(cmdDir)) {
    for (const file of fs.readdirSync(cmdDir)) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(cmdDir, file), "utf-8");
      let desc = "";
      let hint: string | null = null;
      let inFm = false;

      for (const line of content.split("\n")) {
        if (line.trim() === "---") { inFm = !inFm; continue; }
        if (inFm) {
          const dm = line.match(/^description:\s*(.+)/);
          if (dm) desc = dm[1].trim();
          const hm = line.match(/^argument-hint:\s*(.+)/);
          if (hm) hint = hm[1].trim();
        }
      }

      commands.push({
        name: path.basename(file, ".md"),
        description: desc,
        argument_hint: hint,
      });
    }
  }

  // Scan skills
  const skills: string[] = [];
  const skillsDir = path.join(pluginDir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
        skills.push(entry.name);
      }
    }
  }

  return { name: pluginName, description, source, agents, commands, skills };
}

function scanPluginsDir(dir: string, source: string): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  if (!fs.existsSync(dir)) return plugins;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const info = scanPlugin(pluginDir, entry.name, source);
    if (info) plugins.push(info);
  }

  return plugins;
}

export function pluginsRoutes(config: BridgeConfig): Router {
  const router = Router();

  // GET /api/plugins
  router.get("/plugins", asyncHandler(async (_req, res) => {
    const globalDir = path.join(os.homedir(), ".nanobot", "plugins");
    const workspaceDir = path.join(config.workspacePath, "plugins");

    const globalPlugins = scanPluginsDir(globalDir, "global");
    const workspacePlugins = scanPluginsDir(workspaceDir, "workspace");

    // Workspace plugins override global ones with same name
    const pluginMap = new Map<string, PluginInfo>();
    for (const p of globalPlugins) pluginMap.set(p.name, p);
    for (const p of workspacePlugins) pluginMap.set(p.name, p);

    res.json(Array.from(pluginMap.values()));
  }));

  // DELETE /api/plugins/:plugin_name
  router.delete("/plugins/:plugin_name", asyncHandler(async (req, res) => {
    const pluginName = req.params.plugin_name;
    const globalDir = path.join(os.homedir(), ".nanobot", "plugins", pluginName);

    if (!fs.existsSync(globalDir)) {
      res.status(404).json({ detail: "Plugin not installed" });
      return;
    }

    fs.rmSync(globalDir, { recursive: true });
    res.json({ ok: true });
  }));

  return router;
}
