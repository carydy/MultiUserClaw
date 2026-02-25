"""Docker container lifecycle management for per-user nanobot instances."""

from __future__ import annotations

import secrets
from pathlib import Path

import docker
from docker.errors import APIError as DockerAPIError, NotFound as DockerNotFound
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Container

_client: docker.DockerClient | None = None


def _docker() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def _ensure_network() -> None:
    """Create the internal Docker network if it doesn't exist."""
    client = _docker()
    try:
        client.networks.get(settings.container_network)
    except DockerNotFound:
        client.networks.create(
            settings.container_network,
            driver="bridge",
            internal=False,  # no internet access from this network
        )


async def get_container(db: AsyncSession, user_id: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.user_id == user_id))
    return result.scalar_one_or_none()


async def get_container_by_token(db: AsyncSession, token: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.container_token == token))
    return result.scalar_one_or_none()


async def create_container(db: AsyncSession, user_id: str) -> Container:
    """Create a Docker container for a user and record metadata in DB."""
    _ensure_network()
    client = _docker()

    container_token = secrets.token_urlsafe(32)

    # Use Docker named volumes for user data persistence.
    # Named volumes work on all platforms (Linux, macOS Docker Desktop)
    # without needing file-sharing configuration.
    short_id = user_id[:8]
    workspace_vol = f"nanobot-workspace-{short_id}"
    sessions_vol = f"nanobot-sessions-{short_id}"

    container_name = f"nanobot-user-{short_id}"

    # Remove any stale container with the same name (e.g. from a previous
    # failed creation attempt that never got recorded in the DB).
    try:
        stale = client.containers.get(container_name)
        stale.remove(force=True)
    except DockerNotFound:
        pass

    docker_container = client.containers.run(
        image=settings.nanobot_image,
        command=["web", "--port", "18080", "--host", "0.0.0.0"],
        name=container_name,
        detach=True,
        environment={
            "NANOBOT_PROXY__URL": f"http://gateway:8080/llm/v1",
            "NANOBOT_PROXY__TOKEN": container_token,
            "NANOBOT_AGENTS__DEFAULTS__MODEL": settings.default_model,
            # No API keys here — they stay on the platform side
        },
        mounts=[
            docker.types.Mount("/root/.nanobot/workspace", workspace_vol, type="volume"),
            docker.types.Mount("/root/.nanobot/sessions", sessions_vol, type="volume"),
        ],
        network=settings.container_network,
        mem_limit=settings.container_memory_limit,
        nano_cpus=int(settings.container_cpu_limit * 1e9),
        pids_limit=settings.container_pids_limit,
        restart_policy={"Name": "unless-stopped"},
    )

    # Read container IP on the internal network
    docker_container.reload()
    network_settings = docker_container.attrs["NetworkSettings"]["Networks"]
    internal_ip = network_settings.get(settings.container_network, {}).get("IPAddress", "")

    record = Container(
        user_id=user_id,
        docker_id=docker_container.id,
        container_token=container_token,
        status="running",
        internal_host=internal_ip,
        internal_port=18080,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return record


async def ensure_running(db: AsyncSession, user_id: str) -> Container:
    """Return a running container for the user, creating or unpausing as needed."""
    record = await get_container(db, user_id)

    if record is None:
        return await create_container(db, user_id)

    client = _docker()

    if record.status == "paused":
        try:
            c = client.containers.get(record.docker_id)
            c.unpause()
            await db.execute(
                update(Container)
                .where(Container.id == record.id)
                .values(status="running")
            )
            await db.commit()
            record.status = "running"
        except DockerNotFound:
            # Container was removed externally — recreate
            await db.delete(record)
            await db.commit()
            return await create_container(db, user_id)

    elif record.status == "archived":
        # Recreate from persisted data volumes
        await db.delete(record)
        await db.commit()
        return await create_container(db, user_id)

    elif record.status == "running":
        # Verify it's actually running
        try:
            c = client.containers.get(record.docker_id)
            if c.status != "running":
                c.start()
        except DockerNotFound:
            await db.delete(record)
            await db.commit()
            return await create_container(db, user_id)

    return record


async def pause_container(db: AsyncSession, user_id: str) -> bool:
    """Pause a user's container to save resources."""
    record = await get_container(db, user_id)
    if record is None or record.status != "running":
        return False

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)
        c.pause()
        await db.execute(
            update(Container).where(Container.id == record.id).values(status="paused")
        )
        await db.commit()
        return True
    except DockerNotFound:
        return False


async def destroy_container(db: AsyncSession, user_id: str) -> bool:
    """Stop and remove a user's container (data volumes are preserved)."""
    record = await get_container(db, user_id)
    if record is None:
        return False

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)
        c.stop(timeout=10)
        c.remove()
    except DockerNotFound:
        pass

    await db.delete(record)
    await db.commit()
    return True
