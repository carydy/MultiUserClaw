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

_MODEL_PROVIDER_MAP: dict[str, tuple[str, str]] = {
    # keyword in model name → (litellm prefix, settings attr for api key)
    "claude": ("", "anthropic_api_key"),
    "gpt": ("", "openai_api_key"),
    "deepseek": ("deepseek", "deepseek_api_key"),
    "o1": ("", "openai_api_key"),
    "o3": ("", "openai_api_key"),
    "o4": ("", "openai_api_key"),
    "moonshot": ("", "moonshot_api_key"),
    "glm": ("", "zhipu_api_key"),
}

# OpenAI-compatible providers that need a custom api_base
_CUSTOM_BASE_PROVIDERS: dict[str, tuple[str, str]] = {
    # keyword → (api_base, settings attr for api key)
    "qwen": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope_api_key"),
    "kimi": ("https://api.moonshot.cn/v1", "kimi_api_key"),
    "aihubmix": ("https://aihubmix.com/v1", "aihubmix_api_key"),
}

# Models that only accept temperature=1 (or don't support temperature at all)
_FIXED_TEMPERATURE_MODELS = {"kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo"}


def _resolve_provider(model: str) -> tuple[str, str, str | None]:
    """Return (litellm_model_name, api_key, api_base_or_None) for the given model."""
    model_lower = model.lower()
    logger.debug("正在解析模型供应商: model=%r", model)

    # 自托管 vLLM
    if settings.hosted_vllm_api_base:
        vllm_key = settings.hosted_vllm_api_key or "dummy"
        logger.info("模型路由: %s → vLLM (%s)", model, settings.hosted_vllm_api_base)
        return f"hosted_vllm/{model}", vllm_key, settings.hosted_vllm_api_base

    # 先检查自定义 base 的供应商（DashScope、Kimi、AiHubMix 等）
    for keyword, (api_base, key_attr) in _CUSTOM_BASE_PROVIDERS.items():
        if keyword in model_lower:
            api_key = getattr(settings, key_attr, "")
            if api_key:
                actual_model = model.split("/", 1)[1] if "/" in model else model
                logger.info("模型路由: %s → %s (base=%s, 实际模型=%s)", model, keyword, api_base, actual_model)
                return f"openai/{actual_model}", api_key, api_base
            else:
                logger.warning("模型 %s 匹配到关键词 %r，但 %s 为空！请检查 .env 配置", model, keyword, key_attr)

    # 标准供应商
    for keyword, (prefix, key_attr) in _MODEL_PROVIDER_MAP.items():
        if keyword in model_lower:
            api_key = getattr(settings, key_attr, "")
            if api_key:
                litellm_model = f"{prefix}/{model}" if prefix else model
                logger.info("模型路由: %s → %s (litellm=%s)", model, keyword, litellm_model)
                return litellm_model, api_key, None
            else:
                logger.warning("模型 %s 匹配到关键词 %r，但 %s 为空！请检查 .env 配置", model, keyword, key_attr)

    # 兜底：OpenRouter
    if settings.openrouter_api_key:
        logger.info("模型路由: %s → OpenRouter (兜底)", model)
        return f"openrouter/{model}", settings.openrouter_api_key, None

    logger.error(
        "找不到模型 %r 的供应商！已检查: 自定义base=%s, 标准=%s, openrouter=%s",
        model,
        list(_CUSTOM_BASE_PROVIDERS.keys()),
        list(_MODEL_PROVIDER_MAP.keys()),
        bool(settings.openrouter_api_key),
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
