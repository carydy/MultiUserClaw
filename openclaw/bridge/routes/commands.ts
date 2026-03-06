import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeConfig } from "../config.js";
import { asyncHandler } from "../utils.js";

interface CommandInfo {
  name: string;
  description: string;
  argument_hint: string | null;
  plugin_name: string;
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "new", description: "Start a new conversation", argument_hint: null, plugin_name: "builtin" },
  { name: "help", description: "Show available commands", argument_hint: null, plugin_name: "builtin" },
];

function scanPluginCommands(pluginsDir: string): CommandInfo[] {
  const commands: CommandInfo[] = [];
  if (!fs.existsSync(pluginsDir)) return commands;

  for (const pluginName of fs.readdirSync(pluginsDir)) {
    const cmdDir = path.join(pluginsDir, pluginName, "commands");
    if (!fs.existsSync(cmdDir)) continue;

    for (const file of fs.readdirSync(cmdDir)) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(cmdDir, file), "utf-8");

      let description = "";
      let argumentHint: string | null = null;
      let inFrontmatter = false;

      for (const line of content.split("\n")) {
        if (line.trim() === "---") {
          inFrontmatter = !inFrontmatter;
          continue;
        }
        if (inFrontmatter) {
          const descMatch = line.match(/^description:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
          const hintMatch = line.match(/^argument-hint:\s*(.+)/);
          if (hintMatch) argumentHint = hintMatch[1].trim();
        }
      }

      commands.push({
        name: path.basename(file, ".md"),
        description,
        argument_hint: argumentHint,
        plugin_name: pluginName,
      });
    }
  }

  return commands;
}

export function commandsRoutes(config: BridgeConfig): Router {
  const router = Router();

  // GET /api/commands
  router.get("/commands", asyncHandler(async (_req, res) => {
    const commands = [...BUILTIN_COMMANDS];

    // Scan plugin commands
    const globalPluginsDir = path.join(os.homedir(), ".nanobot", "plugins");
    const workspacePluginsDir = path.join(config.workspacePath, "plugins");

    commands.push(...scanPluginCommands(globalPluginsDir));
    commands.push(...scanPluginCommands(workspacePluginsDir));

    // Add skills as commands (excluding collisions)
    const existingNames = new Set(commands.map((c) => c.name));
    const skillsDir = path.join(config.workspacePath, "skills");
    const builtinSkillsDir = path.resolve(process.cwd(), "skills");

    for (const dir of [builtinSkillsDir, skillsDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || existingNames.has(entry.name)) continue;
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;

        const content = fs.readFileSync(skillMd, "utf-8");
        let description = "";
        let inFm = false;
        for (const line of content.split("\n")) {
          if (line.trim() === "---") { inFm = !inFm; continue; }
          if (inFm) {
            const m = line.match(/^description:\s*(.+)/);
            if (m) description = m[1].trim();
          }
        }

        commands.push({
          name: entry.name,
          description,
          argument_hint: null,
          plugin_name: "skill",
        });
        existingNames.add(entry.name);
      }
    }

    res.json(commands);
  }));

  return router;
}
