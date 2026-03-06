"""LLM Proxy API routes — OpenAI-compatible chat/completions endpoint.

User containers hit this endpoint instead of calling LLM providers
directly.  The container token is sent as the Bearer token.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_db
from app.llm_proxy.service import proxy_chat_completion

router = APIRouter(prefix="/llm/v1", tags=["llm-proxy"])


class ChatMessage(BaseModel):
    role: str
    content: str | list | None = None
    tool_calls: list | None = None
    tool_call_id: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    max_tokens: int = 4096
    temperature: float = 0.7
    tools: list[dict] | None = None
    tool_choice: str | None = None
    stream: bool = False


@router.post("/chat/completions")
async def chat_completions(
    request: Request,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
):
    """OpenAI-compatible chat completions endpoint for container proxying."""
    import json as _json

    # Extract container token from "Bearer <token>" header
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    container_token = authorization[7:]

    raw_body = await request.body()
    raw_json = _json.loads(raw_body)

    req = ChatCompletionRequest(**raw_json)

    result = await proxy_chat_completion(
        db=db,
        container_token=container_token,
        model=req.model,
        messages=[m.model_dump(exclude_none=True) for m in req.messages],
        max_tokens=req.max_tokens,
        temperature=req.temperature,
        tools=req.tools,
        stream=req.stream,
    )

    # Streaming: return SSE response
    if req.stream:
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            result,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return result
