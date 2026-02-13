  Nanobot 多租户改造计划（Docker 隔离 + ToC 模式）

  整体架构

  用户浏览器
      │
      ▼
  ┌──────────────────────────────────────────────┐
  │              Platform Gateway                 │
  │  (认证 · 路由 · 容器管理 · 计费 · LLM代理)     │
  │                                              │
  │  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
  │  │ Auth    │ │Container │ │  LLM Proxy   │  │
  │  │ Service │ │ Manager  │ │ (注入Key+计量)│  │
  │  └─────────┘ └──────────┘ └──────────────┘  │
  │                                              │
  │  ┌──────────┐ ┌──────────┐                   │
  │  │ 用户DB   │ │ 用量DB   │                   │
  │  └──────────┘ └──────────┘                   │
  └──────┬───────────┬───────────┬───────────────┘
         │           │           │
     ┌───▼───┐  ┌───▼───┐  ┌───▼───┐
     │User A │  │User B │  │User C │  ← 每用户独立 Docker 容器
     │Nanobot│  │Nanobot│  │Nanobot│
     │       │  │       │  │       │
     │ 无Key │  │ 无Key │  │ 无Key │  ← 容器内没有任何 API Key
     └───┬───┘  └───┬───┘  └───┬───┘
         │          │          │
         └──────────▼──────────┘
            内网调用 LLM Proxy
                │
         ┌──────▼──────┐
         │ Anthropic   │
         │ OpenAI      │  ← 真实 LLM 提供商
         │ DeepSeek... │
         └─────────────┘

  核心安全原则：API Key 只存在于 Platform Gateway 层，永远不进入用户容器。

  ---
  阶段一：Platform Gateway — 新增平台层

  这是全新的服务，作为用户和 Nanobot 容器之间的中间层。

  1.1 技术选型

  - 框架：FastAPI（与 Nanobot 保持一致）
  - 数据库：PostgreSQL（用户、用量、容器元数据）
  - 容器管理：Docker SDK for Python (docker 库)
  - 反向代理：内置或使用 Traefik/Nginx

  1.2 认证服务

  - 用户注册 / 登录（JWT）
  - POST /api/auth/register、POST /api/auth/login、POST /api/auth/refresh
  - 用户表：id, username, email, password_hash, status, created_at, quota_tier

  1.3 请求路由

  - Gateway 接收到前端请求后，根据 JWT 中的 user_id 找到对应容器
  - 将 HTTP / WebSocket 请求转发到该用户的容器内部端口
  - 路由映射表：user_id → container_id → internal_ip:port

  1.4 核心数据模型

  users:          id, username, email, password_hash, status, quota_tier, created_at
  containers:     id, user_id, container_id, status, internal_ip, port, created_at, last_active_at
  usage_records:  id, user_id, model, input_tokens, output_tokens, created_at
  api_keys:       id, provider_name, api_key_encrypted, is_active  (平台级，非用户级)

  ---
  阶段二：LLM Proxy — Key 隔离的核心

  这是最关键的安全组件。用户容器内的 Nanobot 调用 LLM 时，不直接访问 OpenAI/Anthropic，而是请求 Platform 内的 LLM Proxy。

  2.1 工作原理

  用户容器内 Nanobot                    Platform LLM Proxy
       │                                     │
       │  POST /v1/chat/completions          │
       │  Header: X-Container-Token: xxx     │
       │  Body: {model, messages, ...}       │
       │ ──────────────────────────────────►  │
       │                                     │
       │              验证 Container Token    │
       │              注入真实 API Key        │
       │              记录 Token 用量        │
       │              检查配额              │
       │              转发到真实 Provider     │
       │                                     │
       │  ◄──────────────────────────────── │
       │         返回 LLM 响应               │

  2.2 改造 Nanobot 的 Provider 层

  - 改造 nanobot/providers/litellm_provider.py：
    - 新增一个模式：当检测到环境变量 NANOBOT_LLM_PROXY_URL 时，所有 LLM 请求发往该 Proxy
    - 不需要 api_key，改用 X-Container-Token（一个一次性 token，仅用于标识容器身份，不含任何 LLM 密钥信息）
  - 改造 nanobot/config/schema.py：
    - providers 部分在容器内可以完全为空
    - 新增 proxy 配置段：{ "url": "http://gateway:8080/llm", "token": "container-xxx" }

  2.3 Container Token 机制

  - Gateway 创建容器时，生成一个随机 token，注入容器环境变量
  - 这个 token 只能用于调用 LLM Proxy，不是 LLM 的 API Key
  - 即使用户通过 env 看到这个 token，也无法直接调用任何 LLM Provider
  - Proxy 通过 token 反查 user_id，进行配额校验和用量记录

  2.4 额外安全措施

  - LLM Proxy 仅监听 Docker 内部网络（172.x.x.x），不暴露到公网
  - 容器的出站网络通过 iptables/Docker network 限制，只能访问 LLM Proxy，不能直接访问外网 LLM 端点
  - 或使用 Docker network policy：容器只能与 platform 网络通信

  ---
  阶段三：容器生命周期管理

  3.1 容器创建

  - 用户注册/首次登录时，Platform 调用 Docker API 创建专属容器
  - 基于现有 Dockerfile 构建镜像，但不包含任何 API Key
  - 容器启动参数：
  环境变量：
    NANOBOT_LLM_PROXY_URL=http://gateway:8080/llm
    NANOBOT_CONTAINER_TOKEN=random-token-xxx
    NANOBOT_AGENTS__DEFAULTS__MODEL=anthropic/claude-sonnet-4-5  (平台指定可用模型)

  挂载卷：
    /data/users/{user_id}/workspace → /root/.nanobot/workspace
    /data/users/{user_id}/sessions → /root/.nanobot/sessions

  网络：
    连接到 platform-internal 网络

  资源限制：
    --memory=512m --cpus=1.0 --pids-limit=100

  3.2 容器状态管理

  ┌─────────┐   首次登录    ┌─────────┐   空闲超时    ┌─────────┐
  │ 未创建   │ ──────────►  │  运行中  │ ──────────►  │  已暂停  │
  └─────────┘              └─────────┘              └─────────┘
                                ▲                       │
                                │      用户再次访问      │
                                └───────────────────────┘

                           长期不活跃（如30天）
                                │
                                ▼
                           ┌─────────┐
                           │  已归档  │  (数据保留，容器销毁)
                           └─────────┘

  - 运行中：用户活跃时，容器正常运行
  - 暂停：空闲 N 分钟后 docker pause，节省资源
  - 唤醒：用户再次请求时 docker unpause，秒级恢复
  - 归档：长期不活跃，销毁容器但保留数据卷，下次登录重建

  3.3 资源限制（per 容器）
  ┌────────┬──────────────┬──────────────────┐
  │  资源  │     限制     │       说明       │
  ├────────┼──────────────┼──────────────────┤
  │ 内存   │ 512MB - 1GB  │ 根据套餐         │
  ├────────┼──────────────┼──────────────────┤
  │ CPU    │ 0.5 - 1.0 核 │ 根据套餐         │
  ├────────┼──────────────┼──────────────────┤
  │ 磁盘   │ 1GB - 5GB    │ 工作空间大小     │
  ├────────┼──────────────┼──────────────────┤
  │ 进程数 │ 100          │ 防 fork bomb     │
  ├────────┼──────────────┼──────────────────┤
  │ 网络   │ 仅内网       │ 不能直连外部 LLM │
  └────────┴──────────────┴──────────────────┘
  ---
  阶段四：前端改造

  4.1 新增页面

  - /login — 登录页
  - /register — 注册页
  - /dashboard — 用户仪表盘（用量统计、配额余量）

  4.2 改造现有页面

  - frontend/lib/api.ts：
    - 所有请求添加 Authorization: Bearer <jwt> Header
    - API Base URL 指向 Platform Gateway（不再直连 Nanobot 容器）
    - WebSocket 连接时携带 token
  - frontend/lib/store.ts：
    - 新增 user 状态（id, username, email, token）
    - 新增 usage 状态（已用/剩余配额）
  - frontend/app/page.tsx（聊天页）：
    - 未登录重定向到 /login
    - 移除或隐藏 /status 页中的 Provider API Key 信息
  - frontend/components/Header.tsx：
    - 显示当前用户名
    - 登出按钮

  4.3 移除敏感信息暴露

  - 当前 GET /api/status 返回 has_key: true/false — 这个可以保留
  - 但绝不返回 key 的值、前缀、或任何可推断内容
  - 前端 Status 页改为显示"平台已提供模型服务"，不显示 Provider 详情

  ---
  阶段五：用量计量与配额

  5.1 计量点

  - LLM Proxy 是唯一的计量点（所有 LLM 调用必经）
  - 记录：user_id, model, input_tokens, output_tokens, timestamp
  - LiteLLM 的 response 中包含 usage 字段，直接采集

  5.2 配额策略

  quota_tiers:
    free:     100,000 tokens/天
    basic:    1,000,000 tokens/天
    pro:      10,000,000 tokens/天

  - LLM Proxy 在转发前检查当日已用量
  - 超额返回 HTTP 429 + 友好提示
  - 前端实时显示剩余额度

  5.3 模型访问控制

  - 不同套餐可用不同模型
  - 如：free 用户只能用 claude-haiku，pro 可用 claude-opus
  - LLM Proxy 根据 user 的 tier 校验请求的 model 是否允许

  ---
  阶段六：容器内 Nanobot 的安全加固

  6.1 ExecTool 限制增强

  - 当前 shell.py 已有基本的危险命令过滤
  - 新增：禁止 curl/wget 直接访问已知 LLM API 域名（兜底防护）
  - 新增：禁止 apt install/pip install 中的某些危险包（可选，取决于产品定位）

  6.2 网络层隔离（Docker 网络策略）

  # docker-compose.yml 示意
  networks:
    platform-internal:    # Gateway ↔ 容器通信
      internal: true      # 不连接外网
    platform-external:    # Gateway ↔ 外网
      driver: bridge

  # 用户容器只连 platform-internal
  # Gateway 同时连 internal + external
  # 用户容器无法直连 api.openai.com 等

  这是最关键的一层：即使用户拿到了 Container Token，也无法绕过 Proxy 直连 LLM。

  6.3 文件系统保护

  - 容器内的 ~/.nanobot/config.json 不包含任何 providers 信息
  - Proxy URL 和 Container Token 通过环境变量注入（用户可以看到但没用）
  - /root/.nanobot/workspace 通过 Docker volume 持久化，容器重建不丢失

  ---
  阶段七：部署架构

  7.1 单机部署（初期）

  # docker-compose.yml
  services:
    gateway:
      build: ./platform
      ports: ["443:443"]
      networks: [platform-internal, platform-external]
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock  # 管理容器
      environment:
        - DATABASE_URL=postgresql://...
        - ANTHROPIC_API_KEY=sk-ant-...   # Key 只在这里
        - OPENAI_API_KEY=sk-...

    postgres:
      image: postgres:16
      networks: [platform-internal]

    frontend:
      build: ./frontend
      ports: ["3000:3000"]
      networks: [platform-external]

    # 用户容器由 gateway 动态创建，不在 compose 中定义

  7.2 规模化部署（后期）

  - Gateway 无状态化 → 多实例 + 负载均衡
  - 容器编排迁移到 Kubernetes（每用户一个 Pod）
  - 数据卷使用网络存储（NFS / Ceph）
  - LLM Proxy 独立服务化，可水平扩展

  ---
  改造优先级与实施顺序

  阶段二 LLM Proxy          ← 最先做，这是安全基石
      ↓
  阶段一 Platform Gateway    ← 认证 + 路由
      ↓
  阶段三 容器管理            ← 自动创建/暂停/销毁
      ↓
  阶段四 前端改造            ← 登录 + 对接 Gateway
      ↓
  阶段六 安全加固            ← 网络隔离 + 工具限制
      ↓
  阶段五 计量配额            ← 商业化准备
      ↓
  阶段七 部署上线            ← 生产环境部署

  MVP 最小可行方案

  只做三件事即可上线内测：

  1. LLM Proxy（改造 provider 层 + 写一个代理服务）
  2. Platform Gateway（JWT 认证 + 容器创建 + 请求转发）
  3. 前端加登录



  一、Nanobot 本体改动（9 个文件，341 行新增）
  ┌───────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
  │                 文件                  │                                         改动                                          │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ nanobot/config/schema.py              │ 新增 ProxyConfig 配置类和 Config.is_proxy_mode 属性                                   │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ nanobot/providers/litellm_provider.py │ 新增 proxy_url/proxy_token 参数，proxy 模式下跳过 env 设置，模型通过 openai/ 路径转发 │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ nanobot/cli/commands.py               │ _make_provider() 支持 proxy 模式，无需本地 API Key                                    │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ nanobot/web/server.py                 │ _make_provider() 同步支持 proxy 模式                                                  │
  └───────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘
  二、Platform Gateway（全新服务，22 个文件）

  platform/
  ├── Dockerfile                    # 平台镜像
  ├── pyproject.toml                # 依赖（FastAPI, SQLAlchemy, Docker SDK, LiteLLM...）
  ├── alembic.ini + alembic/        # 数据库迁移
  └── app/
      ├── config.py                 # 环境变量配置（数据库、JWT、API Keys、配额...）
      ├── main.py                   # FastAPI 入口，挂载所有路由
      ├── db/
      │   ├── engine.py             # 异步 SQLAlchemy engine
      │   └── models.py             # 4 张表：users, containers, usage_records, audit_logs
      ├── auth/
      │   ├── service.py            # 密码哈希、JWT 签发验证、用户 CRUD
      │   └── dependencies.py       # FastAPI 认证中间件
      ├── container/
      │   └── manager.py            # Docker 容器生命周期（创建/运行/暂停/归档/销毁）
      ├── llm_proxy/
      │   └── service.py            # LLM 代理核心：Token验证→配额检查→Key注入→转发→计量
      └── routes/
          ├── auth.py               # /api/auth/register, login, refresh, me
          ├── llm.py                # /llm/v1/chat/completions （OpenAI兼容）
          ├── proxy.py              # /api/nanobot/* → 反向代理到用户容器 (HTTP + WebSocket)
          └── admin.py              # /api/admin/* 管理员接口

  三、前端改动（6 个文件）
  ┌───────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
  │               文件                │                                          改动                                           │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/types/index.ts           │ 新增 AuthUser, TokenResponse 类型                                                       │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/lib/api.ts               │ Token 管理、auth API、所有请求加 Bearer Header、路径改为 /api/nanobot/*、自动刷新 Token │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/lib/store.ts             │ 新增 user, isAuthLoading 状态                                                           │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/components/AuthGuard.tsx │ 认证守卫组件（未登录跳转 /login）                                                       │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/app/login/page.tsx       │ 登录页面                                                                                │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/app/register/page.tsx    │ 注册页面                                                                                │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/app/layout.tsx           │ 包裹 AuthGuard                                                                          │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ frontend/components/Header.tsx    │ 显示用户名 + 登出按钮                                                                   │
  └───────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘
  四、部署配置
  ┌────────────────────┬───────────────────────────────────────────────────────┐
  │        文件        │                         作用                          │
  ├────────────────────┼───────────────────────────────────────────────────────┤
  │ docker-compose.yml │ 完整部署：PostgreSQL + Gateway + Frontend，双网络隔离 │
  └────────────────────┴───────────────────────────────────────────────────────┘
  安全架构保证

  - API Key 只存在于 docker-compose.yml 的环境变量和 Gateway 进程内存中
  - 用户容器 仅收到 NANOBOT_PROXY__URL 和 NANOBOT_PROXY__TOKEN（无法反推出 API Key）
  - Docker 网络 nanobot-internal 设为 internal: true，容器无法直连外网 LLM 端点
  - 即使用户在容器内执行 env、cat ~/.nanobot/config.json，也看不到任何 LLM API Key


# 当前 LLM 代理架构

  用户浏览器 → 前端 → gateway → 用户容器(nanobot)
                                      ↓ (代理LLM请求)
                                  gateway/llm/v1
                                      ↓ (注入真实API Key)
                                  实际 LLM 提供商

  - 用户容器没有 API Key，通过 NANOBOT_PROXY__URL=http://gateway:8080/llm/v1 把 LLM 请求代理到 gateway
  - Gateway 收到请求后：认证 → 检查配额 → 根据模型名找到对应的 API Key → 调用真实 LLM → 记录用量
  - 问题：gateway 只支持 4 个提供商（anthropic/openai/deepseek/openrouter），而你实际用的是 DashScope，gateway 不认识这个提供商
LLM 代理的完整流程：

  用户选择模型 (如 dashscope/qwen3-coder-plus)
      ↓
  用户容器 → 发送LLM请求到 gateway (http://gateway:8080/llm/v1)
      ↓
  Gateway _resolve_provider():
    - "qwen" 在模型名中 → 找到 DashScope 配置
    - 注入 PLATFORM_DASHSCOPE_API_KEY
    - 设置 api_base = https://dashscope.aliyuncs.com/compatible-mode/v1
      ↓
  Gateway → 调用真实 DashScope API → 返回结果 → 记录用量


# 操作
## 创建nanobot的容器
docker build -t nanobot:latest .

## 启动gateway和web端，web端供用户访问，gateway给每个用户创建nanobot容器
docker compose build --no-cache frontend && docker compose up -d 
docker compose build --no-cache gateway && docker compose up -d
删除gateway和用户容器，重建，防止缓存问题
docker compose build --no-cache gateway && docker rm -f nanobot-user-9abeea27 && docker compose up -d
docker compose logs -f 
docker compose down


# 删除用户创建的容器
docker ps -a --filter "name=nanobot-user-" --format "{{.Names}}" 2>&1
docker rm -f nanobot-user-9abeea27 2>&1