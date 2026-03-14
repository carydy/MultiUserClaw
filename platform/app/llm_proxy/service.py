"""LLM Proxy — the security core of the multi-tenant platform.

Receives OpenAI-compatible requests from user containers (authenticated
by container token), injects the real API key, records usage, enforces
quotas, and forwards to the actual LLM provider.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta

from fastapi import HTTPException, status
from litellm import acompletion
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import decode_token
from app.config import settings
from app.db.models import Container, UsageRecord, User

logger = logging.getLogger("platform.llm_proxy")


# ---------------------------------------------------------------------------
# Model → provider mapping
# ---------------------------------------------------------------------------
# 每个 provider 定义:
#   prefix:      用户在 DEFAULT_MODEL 或前端选模型时使用的前缀，如 "openai/gpt-4o"
#   key_attr:    settings 中 API Key 的属性名
#   litellm_fmt: litellm 调用时的模型名格式，{model} 会被替换为去掉前缀后的模型名
#   api_base:    自定义 API 端点（None 表示使用 litellm 默认）
#   keywords:    模型名中包含这些关键词时自动匹配（不需要显式前缀）

_PROVIDERS: list[dict] = [
    # --- 标准云端 provider ---
    {
        "prefix": "claude",
        "key_attr": "anthropic_api_key",
        "litellm_fmt": "{model}",
        "api_base": None,
        "keywords": ["claude"],
    },
    {
        "prefix": "openai",
        "key_attr": "openai_api_key",
        "litellm_fmt": "{model}",
        "api_base": None,
        "keywords": ["gpt", "o1", "o3", "o4"],
    },
    {
        "prefix": "deepseek",
        "key_attr": "deepseek_api_key",
        "litellm_fmt": "deepseek/{model}",
        "api_base": None,
        "keywords": ["deepseek"],
    },
    # --- 需要自定义 api_base 的 OpenAI 兼容 provider ---
    {
        "prefix": "dashscope",
        "key_attr": "dashscope_api_key",
        "litellm_fmt": "openai/{model}",
        "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "keywords": ["qwen"],
    },
    {
        "prefix": "kimi",
        "key_attr": "kimi_api_key",
        "litellm_fmt": "openai/{model}",
        "api_base": "https://api.moonshot.cn/v1",
        "keywords": ["kimi", "moonshot"],
    },
    {
        "prefix": "zhipu",
        "key_attr": "zhipu_api_key",
        "litellm_fmt": "openai/{model}",
        "api_base": "https://open.bigmodel.cn/api/paas/v4",
        "keywords": ["glm"],
    },
    {
        "prefix": "doubao",
        "key_attr": "doubao_api_key",
        "litellm_fmt": "openai/{model}",
        "api_base": "https://ark.cn-beijing.volces.com/api/v3",
        "keywords": ["doubao"],
    },
    {
        "prefix": "aihubmix",
        "key_attr": "aihubmix_api_key",
        "litellm_fmt": "openai/{model}",
        "api_base": "https://aihubmix.com/v1",
        "keywords": ["aihubmix"],
    },
    # --- 自托管 vLLM ---
    {
        "prefix": "vllm",
        "key_attr": "hosted_vllm_api_key",
        "litellm_fmt": "hosted_vllm/{model}",
        "api_base_attr": "hosted_vllm_api_base",  # 从 settings 动态读取
        "keywords": [],  # 无关键词匹配，仅通过显式前缀或兜底
    },
]

# 构建前缀查找表: "claude" → provider dict
_PREFIX_MAP: dict[str, dict] = {p["prefix"]: p for p in _PROVIDERS}

# 构建关键词查找表: "gpt" → provider dict
_KEYWORD_MAP: dict[str, dict] = {}
for _p in _PROVIDERS:
    for _kw in _p.get("keywords", []):
        _KEYWORD_MAP[_kw] = _p

# Models that only accept temperature=1 (or don't support temperature at all)
_FIXED_TEMPERATURE_MODELS = {"kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo"}


def _get_provider_key_and_base(provider: dict) -> tuple[str, str | None]:
    """从 provider 定义中获取 api_key 和 api_base。"""
    api_key = getattr(settings, provider["key_attr"], "") or ""
    # api_base 可以是固定值，也可以从 settings 动态读取
    if "api_base_attr" in provider:
        api_base = getattr(settings, provider["api_base_attr"], "") or None
    else:
        api_base = provider.get("api_base")
    # vLLM 等无固定 key 的 provider，给个 dummy
    if not api_key and provider["prefix"] == "vllm":
        api_key = "dummy"
    return api_key, api_base


def _resolve_provider(model: str) -> tuple[str, str, str | None]:
    """Return (litellm_model_name, api_key, api_base_or_None) for the given model.

    路由优先级:
      1. 显式前缀 — "openai/gpt-4o", "vllm/Qwen2.5-7B", "dashscope/qwen-turbo" 等
      2. 关键词匹配 — 模型名含 "claude"、"gpt"、"qwen" 等自动路由
      3. 兜底: vLLM → OpenRouter → 报错
    """
    model_lower = model.lower()
    logger.debug("正在解析模型供应商: model=%r", model)

    # ---- 1. 显式前缀匹配 ----
    if "/" in model:
        prefix = model_lower.split("/", 1)[0]
        if prefix in _PREFIX_MAP:
            provider = _PREFIX_MAP[prefix]
            actual_model = model.split("/", 1)[1]
            api_key, api_base = _get_provider_key_and_base(provider)
            if api_key:
                litellm_model = provider["litellm_fmt"].format(model=actual_model)
                logger.info("模型路由: %s → %s (显式前缀, litellm=%s)", model, prefix, litellm_model)
                return litellm_model, api_key, api_base
            else:
                logger.warning("模型 %s 使用显式前缀 %r，但 %s 为空！", model, prefix, provider["key_attr"])

    # ---- 2. 关键词自动匹配 ----
    for keyword, provider in _KEYWORD_MAP.items():
        if keyword in model_lower:
            api_key, api_base = _get_provider_key_and_base(provider)
            if api_key:
                actual_model = model.split("/", 1)[1] if "/" in model else model
                litellm_model = provider["litellm_fmt"].format(model=actual_model)
                logger.info("模型路由: %s → %s (关键词=%r, litellm=%s)", model, provider["prefix"], keyword, litellm_model)
                return litellm_model, api_key, api_base
            else:
                logger.warning("模型 %s 匹配到关键词 %r，但 %s 为空！", model, keyword, provider["key_attr"])

    # ---- 3. 兜底: vLLM ----
    if settings.hosted_vllm_api_base:
        vllm_key = settings.hosted_vllm_api_key or "dummy"
        logger.info("模型路由: %s → vLLM (兜底, base=%s)", model, settings.hosted_vllm_api_base)
        return f"hosted_vllm/{model}", vllm_key, settings.hosted_vllm_api_base

    # ---- 4. 兜底: OpenRouter ----
    if settings.openrouter_api_key:
        logger.info("模型路由: %s → OpenRouter (兜底)", model)
        return f"openrouter/{model}", settings.openrouter_api_key, None

    logger.error(
        "找不到模型 %r 的供应商！已注册前缀: %s, 关键词: %s",
        model,
        list(_PREFIX_MAP.keys()),
        list(_KEYWORD_MAP.keys()),
    )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"No provider configured for model '{model}'",
    )


# ---------------------------------------------------------------------------
# Quota check
# ---------------------------------------------------------------------------

_TIER_LIMITS = {
    "free": settings.quota_free,
    "basic": settings.quota_basic,
    "pro": settings.quota_pro,
}


async def _check_quota(db: AsyncSession, user: User) -> None:
    """Raise 429 if the user exceeded their daily quota."""
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    result = await db.execute(
        select(func.coalesce(func.sum(UsageRecord.total_tokens), 0)).where(
            UsageRecord.user_id == user.id,
            UsageRecord.created_at >= today_start,
        )
    )
    used_today: int = result.scalar_one()
    limit = _TIER_LIMITS.get(user.quota_tier, _TIER_LIMITS["free"])

    if used_today >= limit:
        logger.warning("用户 %s 超出每日配额: %d/%d", user.id, used_today, limit)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily token quota exceeded ({used_today:,}/{limit:,}). Resets at midnight UTC.",
        )


# ---------------------------------------------------------------------------
# Core proxy handler
# ---------------------------------------------------------------------------

async def proxy_chat_completion(
    db: AsyncSession,
    container_token: str,
    model: str,
    messages: list[dict],
    max_tokens: int = 4096,
    temperature: float = 0.7,
    tools: list[dict] | None = None,
    stream: bool = False,
):
    """Validate token, check quota, forward to real LLM, record usage."""
    logger.info("收到 LLM 请求: model=%s, stream=%s, 消息数=%d, 工具数=%s",
                model, stream, len(messages), len(tools) if tools else 0)

    # 1. Authenticate — supports container token or JWT API token
    # In local dev mode (dev_openclaw_url set), skip validation and quota check.
    if settings.dev_openclaw_url:
        logger.debug("开发模式: 跳过认证和配额检查")
        container = None
        user = None
    else:
        container = None
        user = None

        # Try JWT API token first
        jwt_payload = decode_token(container_token)
        if jwt_payload and jwt_payload.get("type") == "access":
            user_id = jwt_payload.get("sub")
            if user_id:
                user_result = await db.execute(select(User).where(User.id == user_id))
                user = user_result.scalar_one_or_none()
                if user:
                    logger.debug("JWT 认证成功: user=%s", user_id[:8])

        # Fallback: container token
        if user is None:
            result = await db.execute(
                select(Container).where(Container.container_token == container_token)
            )
            container = result.scalar_one_or_none()
            if container is None:
                logger.warning("认证失败: 无效的 token")
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
            logger.debug("容器 token 认证成功: container=%s", container.id[:8] if container.id else "?")
            user_result = await db.execute(select(User).where(User.id == container.user_id))
            user = user_result.scalar_one_or_none()

        if user is None or not user.is_active:
            logger.warning("用户账户不可用")
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account disabled")

        await _check_quota(db, user)

    # 3. Resolve provider
    litellm_model, api_key, api_base = _resolve_provider(model)

    # 4. Call LLM
    kwargs: dict = {
        "model": litellm_model,
        "messages": messages,
        "max_tokens": max_tokens,
        "api_key": api_key,
        "stream": stream,
    }
    # Some models (e.g. kimi-k2.5) only accept temperature=1; skip the param for them.
    model_base = model.split("/")[-1].lower()
    if model_base not in _FIXED_TEMPERATURE_MODELS:
        kwargs["temperature"] = temperature
    if api_base:
        kwargs["api_base"] = api_base
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"

    try:
        response = await acompletion(**kwargs)
    except Exception as e:
        safe_kwargs = {k: (v if k != "messages" else f"[{len(v)} 条消息]")
                       for k, v in kwargs.items() if k != "api_key"}
        logger.error("LLM 调用失败: model=%s, 错误=%s", model, e)
        logger.error("LLM 调用参数 (不含密钥): %s", safe_kwargs)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM provider error: {e}",
        )

    # 4b. Streaming: return an async generator that yields SSE chunks
    if stream:
        import json

        async def _stream_generator():
            try:
                async for chunk in response:
                    data = chunk.model_dump()
                    yield f"data: {json.dumps(data)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception:
                yield "data: [DONE]\n\n"

        return _stream_generator()

    # 5. Record usage (skip in dev mode)
    usage = getattr(response, "usage", None)
    if usage:
        logger.info("LLM 响应完成: model=%s, 总token=%d (输入=%d, 输出=%d)",
                     model, usage.total_tokens or 0, usage.prompt_tokens or 0, usage.completion_tokens or 0)
    if user is not None:
        if usage:
            record = UsageRecord(
                user_id=user.id,
                model=model,
                input_tokens=usage.prompt_tokens or 0,
                output_tokens=usage.completion_tokens or 0,
                total_tokens=usage.total_tokens or 0,
            )
            db.add(record)
            await db.commit()

    # 6. Update container last_active_at (skip in dev mode)
    if container is not None:
        container.last_active_at = datetime.utcnow()
        await db.commit()

    # 7. Return OpenAI-compatible response
    return response.model_dump()
