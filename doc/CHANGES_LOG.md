# 变更日志

## 2026-03-05: Nanobot → OpenClaw Bridge 替换

### 概述

将原有的 Nanobot（Python）Agent 替换为 OpenClaw（TypeScript），通过新增 Bridge 适配层实现 API 兼容，保持前端和 Platform 网关无感切换。

### 架构变化

```
替换前：
  Frontend → Platform Gateway → Nanobot (Python, port 18080)

替换后：
  Frontend → Platform Gateway → Bridge Server (Express, port 18080)
                                      ↓ (内部 WebSocket)
                                OpenClaw Gateway (port 18789)
                                      ↓
                                LLM Provider
```

### 新增文件（openclaw/bridge/）

| 文件 | 说明 |
|------|------|
| `bridge/config.ts` | 环境变量解析，生成 openclaw 配置文件（~/.openclaw/openclaw.json） |
| `bridge/gateway-client.ts` | WebSocket 客户端，封装与 OpenClaw Gateway 的连接和 RPC 调用 |
| `bridge/server.ts` | Express HTTP 服务器主入口，挂载所有路由 |
| `bridge/start.ts` | 启动入口：启动 openclaw gateway 子进程 → 等待就绪 → 启动 bridge 服务器 |
| `bridge/websocket.ts` | WebSocket 处理器（/ws/{session_id}），转换 openclaw 聊天事件为 nanobot 格式 |
| `bridge/utils.ts` | 通用工具函数（asyncHandler、session key 转换、文本提取等） |
| `bridge/types.d.ts` | unzipper 模块类型声明 |
| `bridge/routes/chat.ts` | POST /api/chat 和 /api/chat/stream（SSE 流式响应） |
| `bridge/routes/sessions.ts` | GET/DELETE /api/sessions 会话管理 |
| `bridge/routes/status.ts` | GET /api/status 和 /api/ping |
| `bridge/routes/files.ts` | 文件上传/下载/列表/删除（直接文件系统实现） |
| `bridge/routes/workspace.ts` | 工作区浏览/上传/下载/删除/创建目录 |
| `bridge/routes/skills.ts` | 技能列表/上传/下载/删除（支持 zip 打包） |
| `bridge/routes/commands.ts` | 命令列表（内置 + 插件 + 技能） |
| `bridge/routes/plugins.ts` | 插件列表/删除 |
| `bridge/routes/cron.ts` | 定时任务 CRUD（通过 gateway RPC） |
| `bridge/routes/marketplaces.ts` | 市场管理 CRUD（git clone + 文件系统） |
| `bridge/package.json` | Bridge 依赖（express, ws, multer, mime-types, archiver, unzipper） |
| `tsconfig.bridge.json` | Bridge TypeScript 编译配置 |
| `Dockerfile.bridge` | Docker 镜像构建文件 |
| `bridge-entrypoint.sh` | Docker 入口脚本 |

### 修改的文件

| 文件 | 修改内容 |
|------|----------|
| `platform/app/config.py` | `nanobot_image` 默认值改为 `"openclaw-bridge:latest"` |
| `platform/app/container/manager.py` | 容器启动命令改为 `node bridge/dist/start.js`，volume 挂载路径改为 `/root/.openclaw/` |
| `start_local.py` | "nanobot" 服务改为 "bridge"，启动方式改为 `tsx bridge/start.ts`，超时增加到 120s |
| `deploy_docker.py` | 镜像构建改为 `openclaw-bridge:latest`，使用 `openclaw/Dockerfile.bridge` |
| `prepare.py` | 去掉 nanobot Python 依赖检查，改为检查 openclaw（pnpm install）和 bridge（npm install）依赖 |
| `check_status.py` | 用户容器健康检查从 python3 改为 node（fetch API） |

### 关键技术细节

#### OpenClaw 配置格式（~/.openclaw/openclaw.json）

```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "platform-proxy": {
        "baseUrl": "http://localhost:8080/llm/v1",
        "api": "openai-completions",
        "apiKey": "<token>",
        "models": [{ "id": "<model>", "name": "<model>" }]
      }
    }
  },
  "agents": { "defaults": { "model": "platform-proxy/<model>" } },
  "gateway": { "mode": "local", "port": 18789, "bind": "loopback", "auth": { "mode": "none" } }
}
```

注意事项：
- Provider 字段用 `api: "openai-completions"`（不是 `type: "openai"`）
- Model 必须同时有 `id` 和 `name`
- Agent model 引用格式为 `"provider-name/model-id"`
- Gateway 必须设置 `mode: "local"`

#### 设备身份认证（Device Identity）

即使 gateway 配置 `auth.mode = "none"`，连接时仍需提供设备身份（Ed25519 密钥对 + 签名）。

流程：
1. 客户端生成临时 Ed25519 密钥对
2. 收到 `connect.challenge` 事件，提取 nonce
3. 构建 v3 payload 字符串（`v3|deviceId|clientId|mode|role|scopes|timestamp|token|nonce|platform|deviceFamily`）
4. 用私钥签名 payload
5. 在 connect 请求中携带 `device` 对象（id, publicKey, signature, signedAt, nonce）

`client.id` 必须是预定义值之一（如 `"gateway-client"`），不能自定义。

### 调试过程中遇到的问题

1. **配置格式错误**：`type` → `api`，缺少 `name`，`provider` 字段无效
2. **Gateway 模式未设置**：必须显式设置 `mode: "local"`
3. **Connect 参数 schema 不匹配**：需要嵌套 `client` 对象，包含 `minProtocol/maxProtocol`
4. **设备身份必需**：auth=none 模式下 `sharedAuthOk` 为 false，无法跳过设备身份验证
5. **Client ID 校验**：必须使用 `GATEWAY_CLIENT_IDS` 中定义的值


  前端（8 个文件）：
  - lib/api.ts — 所有 /api/nanobot/ → /api/openclaw/，localStorage keys 改名
  - lib/store.ts — nanobotReady → openclawReady
  - app/page.tsx — UI 文本和变量名
  - app/layout.tsx — 页面标题 → "OpenClaw"
  - app/help/page.tsx — 帮助文档文本
  - app/status/page.tsx — 错误信息和命令
  - app/plugins/page.tsx — 路径和文本
  - app/login/page.tsx + app/register/page.tsx — 登录/注册标题
  - components/Header.tsx — 头部显示和状态变量
  - types/index.ts — 注释

  平台 Gateway（5 个文件）：
  - routes/proxy.py — 路由前缀 /api/openclaw，配置引用
  - config.py — dev_openclaw_url、openclaw_image、网络名等
  - main.py — 服务名
  - llm_proxy/service.py — 配置引用
  - container/manager.py — 容器/卷名

  基础设施（2 个文件）：
  - Dockerfile — .openclaw 目录、入口点
  - start_local.py — Docker 容器名、环境变量、UI 文本

openclaw/Dockerfile.bridge 已经包含了完整的 openclaw 主程序（COPY . . + pnpm build），不是只有
  bridge


  Chat 页面

  - 输入框左侧新增 📎 附件按钮，支持选择多个文件
  - 支持粘贴图片（Ctrl+V / Cmd+V）
  - 文件预览区：图片显示缩略图，文件显示名称和大小，可单独删除
  - 发送逻辑：
    - 图片（image/*）→ base64 编码作为 attachment 直接发给网关
    - 其他文件（PDF/文档等）→ 先上传到 workspace/uploads/ 目录，然后在消息中插入 [附件: workspace/uploads/xxx.pdf] 引用路径，Agent
  可通过文件系统工具读取处理


  WebSocket（精确信号）：
  - 页面加载时连接 /api/openclaw/ws?token=JWT
  - 完成 Gateway 握手协议（connect.challenge → connect 请求，protocol v3）
  - 监听 chat 事件，当 state 为 "final" / "error" / "aborted" 时：
    - 立即刷新消息列表
    - 设置 sending=false，结束加载动画
    - 通过 wsCompletedRef 中断轮询循环
  - 断线自动重连（3秒）

  轮询（兜底 + 中间消息）：
  - 每2秒拉取消息列表，实时显示 Agent 的中间回复
  - 如果 WebSocket 已经触发完成，轮询立即退出
  - 如果 WebSocket 不可用，15秒稳定阈值兜底


  1. 认证失败 (gateway token missing)

  原因: writeOpenclawConfig 保留了用户已有的 gateway 配置，但用户的配置里没有 auth: { mode: "none" }，导致 gateway 要求 token 但 bridge 不带
  token。

  修复 (config.ts):
  - gateway.auth = { mode: "none" } 始终强制设置 — bridge 直连 gateway 必须免认证
  - gateway.mode/port/bind 也始终确保正确
  - models.mode 不再强制 "replace"，改为默认 "merge"，保留用户的其他 providers（如 moonshot）
  - controlUi.allowedOrigins 合并用户已有的和默认的

  2. 渠道不启动 (OPENCLAW_SKIP_CHANNELS)

  原因: bridge 启动 gateway 时固定传 OPENCLAW_SKIP_CHANNELS=1，跳过所有渠道。

  修复:
  - 新增环境变量 BRIDGE_ENABLE_CHANNELS=1 控制是否启用渠道
  - start_local.py 自动传入 BRIDGE_ENABLE_CHANNELS=1，本地开发模式飞书等渠道正常工作
  - Docker 模式默认仍跳过（多租户每用户独立容器）

  3. 新增插件管理页面

  - 后端 (plugins.ts): 扫描 ~/.openclaw/extensions/ 目录，读取 openclaw.json 中的 plugins.installs 元数据；新增 POST /api/plugins/install 和
  DELETE /api/plugins/:name 调用 openclaw CLI 安装/卸载
  - 前端 (Plugins.tsx): 新页面 /plugins，显示已安装插件列表 + 可用渠道扩展目录（飞书、Matrix、Teams 等），支持一键安装/卸载，带 npm
  包名输入框手动安装
  - 侧边栏: 技能中心下新增「插件管理」入口


  根本原因：Gateway 的 WebSocket 协议要求 Ed25519 设备认证签名（见 bridge 的 gateway-client.ts），前端发送的 connect 请求缺少 device
  字段和签名，所以 gateway 握手后立即断开(code 1000)，导致：
  - 无法收到 delta 事件 → 无流式显示
  - 不断重连 → 大量 WS 连接/断开循环

  解决方案：用 SSE (Server-Sent Events) 替代 WebSocket

  1. Bridge gateway-client.ts — 添加 offEvent() 方法用于清理 SSE 连接的监听器
  2. Bridge routes/events.ts (新文件) — SSE 端点 /api/events/stream，通过 bridge 已有的 BridgeGatewayClient（已正确认证）接收 gateway 的 chat
  事件，以 SSE 格式推送给前端
  3. Bridge server.ts — 挂载 events 路由
  4. Platform proxy.py — 对 events/stream 路径特殊处理，用 httpx.stream() 流式代理 SSE，不缓冲
  5. Frontend Chat.tsx — 整个 WebSocket 代码替换为 EventSource (SSE)：
    - 无需 gateway 握手/认证
    - 浏览器原生自动重连（内建退避）
    - 接收 delta/started/final 事件，实现流式文字显示
    - 流式显示时有闪烁光标动画
  6. vite.config.ts — 移除不再需要的 WS 代理配置

  重启 start_local.py 后测试即可。


  为什么之前不显示

  Agent 发现机制是扫描 ~/.openclaw/agents/<id>/ 目录 + openclaw.json 的 agents.list，而不是从 workspace
  目录发现。你只是把文件放进去了，但没有：
  1. 创建 ~/.openclaw/agents/<id>/ 目录
  2. 在 openclaw.json 中注册

  修改了什么

  start_local.py（本地部署）：
  - 新增 _sync_agents() 函数：遍历 deploy_copy/Agents/ 每个子目录
  - 新增 _register_agents_in_config()：把 agent 写入 openclaw.json 的 agents.list
  - 对每个 agent 做三件事：
    a. ~/.openclaw/agents/<id>/ — 创建目录（gateway 磁盘发现）
    b. ~/.openclaw/workspace-<id>/ — 同步 SOUL.md 等工作区文件
    c. openclaw.json agents.list[] — 注册 id、name、workspace 路径

  bridge-entrypoint.sh（Docker 容器启动）：
  - 同样的三步逻辑，用 bash + node 实现
  - 遍历 /deploy-copy/Agents/*/，为每个 agent 创建目录、同步文件、注册配置

  两个脚本都是幂等的 — 已存在的文件不覆盖，已注册的 agent 不重复注册。
