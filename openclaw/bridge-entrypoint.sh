#!/bin/bash
set -e

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

# Create necessary directories
mkdir -p "$OPENCLAW_HOME/workspace"
mkdir -p "$OPENCLAW_HOME/uploads"
mkdir -p "$OPENCLAW_HOME/sessions"
mkdir -p "$OPENCLAW_HOME/skills"
mkdir -p "$OPENCLAW_HOME/extensions"
mkdir -p "$OPENCLAW_HOME/agents"

# Clean stale Chromium profile lock files left by previous container/host runs.
# Without this, OpenClaw managed browser may fail with "profile appears to be in use".
if [ -d "$OPENCLAW_HOME/browser" ]; then
  find "$OPENCLAW_HOME/browser" -type d -path "*/user-data" | while read profile_dir; do
    removed=0
    for lock_name in SingletonLock SingletonCookie SingletonSocket; do
      lock_path="$profile_dir/$lock_name"
      if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then
        rm -f "$lock_path"
        removed=1
      fi
    done
    if [ "$removed" -eq 1 ]; then
      echo "[entrypoint] Cleared stale Chromium lock(s): $profile_dir"
    fi
  done
fi

#如果不存在默认openclaw.json文件，初始化1个空的
if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
  echo "{}" > "$OPENCLAW_HOME/openclaw.json"
  echo "[entrypoint] Initialized $OPENCLAW_HOME/openclaw.json"
fi
# 同步需要预先拷贝的配置，skills和agents到容器
if [ -d /deploy-copy ]; then
  echo "[entrypoint] Syncing deploy templates..."

  # Sync Agents — each subdirectory becomes a registered agent
  if [ -d /deploy-copy/Agents ]; then
    for agent_src in /deploy-copy/Agents/*/; do
      [ -d "$agent_src" ] || continue
      agent_name="$(basename "$agent_src")"
      agent_id="$(echo "$agent_name" | tr '[:upper:]' '[:lower:]')"

      # 1. Create agents/<id>/ directory (for gateway disk discovery)
      mkdir -p "$OPENCLAW_HOME/agents/$agent_id"

      # 2. Sync workspace files to workspace-<id>/
      workspace_dir="$OPENCLAW_HOME/workspace-$agent_id"
      mkdir -p "$workspace_dir"
      find "$agent_src" -type f | while read src; do
        rel="${src#$agent_src}"
        dst="$workspace_dir/$rel"
        if [ ! -f "$dst" ]; then
          cp "$src" "$dst"
          echo "[entrypoint]   + workspace-$agent_id/$rel"
        fi
      done

      echo "[entrypoint]   Agent discovered: $agent_name → workspace-$agent_id/"
    done

    # 3. Register agents in openclaw.json
    if [ -f "$OPENCLAW_HOME/openclaw.json" ] && command -v node &> /dev/null; then
      node -e "
        const fs = require('fs');
        const path = require('path');
        const agentsDir = '/deploy-copy/Agents';
        const configPath = '$OPENCLAW_HOME/openclaw.json';
        const openclawHome = '$OPENCLAW_HOME';

        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!config.agents) config.agents = {};
        if (!config.agents.list) config.agents.list = [];

        const existingIds = new Set(config.agents.list.map(e => (e.id || '').toLowerCase()));
        let changed = false;

        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const agentId = entry.name.toLowerCase();
          if (existingIds.has(agentId)) continue;

          config.agents.list.push({
            id: agentId,
            name: entry.name,
            workspace: path.join(openclawHome, 'workspace-' + agentId),
          });
          console.log('[entrypoint]   Registered agent: ' + entry.name);
          changed = true;
        }

        // Ensure default 'main' agent is always registered
        if (!existingIds.has('main')) {
          const mainWorkspace = path.join(openclawHome, 'workspace');
          config.agents.list.unshift({
            id: 'main',
            name: 'main',
            workspace: mainWorkspace,
            default: true,
          });
          console.log('[entrypoint]   Registered default agent: main');
          changed = true;
        }

        if (changed) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      "
    fi
  fi

  # Sync extensions (openclaw plugins)
  if [ -d /deploy-copy/extensions ]; then
    mkdir -p "$OPENCLAW_HOME/extensions"
    find /deploy-copy/extensions -type f | while read src; do
      rel="${src#/deploy-copy/extensions/}"
      dst="$OPENCLAW_HOME/extensions/$rel"
      if [ ! -f "$dst" ]; then
        parent="$(dirname "$dst")"
        if [ -f "$parent" ]; then rm -rf "$parent"; fi
        mkdir -p "$parent"
        cp "$src" "$dst"
        echo "[entrypoint]   + extensions/$rel"
      fi
    done
  fi

  # Sync skills
  if [ -d /deploy-copy/skills ]; then
    find /deploy-copy/skills -type f | while read src; do
      rel="${src#/deploy-copy/skills/}"
      dst="$OPENCLAW_HOME/skills/$rel"
      if [ ! -f "$dst" ]; then
        parent="$(dirname "$dst")"
        if [ -f "$parent" ]; then rm -rf "$parent"; fi
        mkdir -p "$parent"
        cp "$src" "$dst"
        echo "[entrypoint]   + skills/$rel"
      fi
    done
  fi

  # Deep merge openclaw_defaults.json into openclaw.json (add missing keys at any depth)
  if [ -f /deploy-copy/openclaw_defaults.json ]; then
    if command -v node &> /dev/null; then
      node -e "
        const fs = require('fs');
        const defaultsPath = '/deploy-copy/openclaw_defaults.json';
        const configPath = '$OPENCLAW_HOME/openclaw.json';
        const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));

        // If config doesn't exist, just copy defaults
        if (!fs.existsSync(configPath)) {
          fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
          console.log('[entrypoint]   Created openclaw.json from defaults');
          process.exit(0);
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        // Recursive deep merge: add missing keys without overwriting existing leaf values
        // For arrays of objects with 'id' field, merge by matching id
        function deepMerge(base, override) {
          let changed = false;
          for (const [key, value] of Object.entries(override)) {
            if (!(key in base)) {
              base[key] = JSON.parse(JSON.stringify(value));
              changed = true;
            } else if (value && typeof value === 'object' && !Array.isArray(value)
                       && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
              if (deepMerge(base[key], value)) changed = true;
            } else if (Array.isArray(value) && Array.isArray(base[key])) {
              // For arrays of objects with 'id', merge by id
              if (value.length > 0 && value[0] && typeof value[0] === 'object' && 'id' in value[0]
                  && base[key].length > 0 && base[key][0] && typeof base[key][0] === 'object' && 'id' in base[key][0]) {
                const baseById = {};
                for (const item of base[key]) {
                  if (item && typeof item === 'object' && 'id' in item) baseById[item.id] = item;
                }
                for (const overrideItem of value) {
                  if (!overrideItem || typeof overrideItem !== 'object' || !('id' in overrideItem)) continue;
                  if (overrideItem.id in baseById) {
                    if (deepMerge(baseById[overrideItem.id], overrideItem)) changed = true;
                  } else {
                    base[key].push(JSON.parse(JSON.stringify(overrideItem)));
                    changed = true;
                  }
                }
              }
              // Other arrays: keep base value, don't overwrite
            }
            // Other types (string, number, bool): keep base value, don't overwrite
          }
          return changed;
        }

        if (deepMerge(config, defaults)) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          console.log('[entrypoint]   Deep merged openclaw_defaults.json');
        }
      "
    fi
  fi

  # Sync SSH keys
  if [ -d /deploy-copy/ssh ]; then
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    for keyfile in /deploy-copy/ssh/*; do
      [ -f "$keyfile" ] || continue
      dst="/root/.ssh/$(basename "$keyfile")"
      cp "$keyfile" "$dst"
      # Private keys need 600, public keys and config 644
      case "$(basename "$keyfile")" in
        *.pub|config|known_hosts) chmod 644 "$dst" ;;
        *) chmod 600 "$dst" ;;
      esac
      echo "[entrypoint]   + .ssh/$(basename "$keyfile")"
    done
    echo "[entrypoint] SSH keys synced"
  fi

  echo "[entrypoint] Deploy templates synced"
fi

# If NANOBOT_PROXY__URL is set, we're running in platform mode
if [ -n "$NANOBOT_PROXY__URL" ]; then
  echo "[entrypoint] Platform mode detected"
  echo "[entrypoint] Proxy URL: $NANOBOT_PROXY__URL"
  echo "[entrypoint] Model: $NANOBOT_AGENTS__DEFAULTS__MODEL"
fi

exec "$@"
