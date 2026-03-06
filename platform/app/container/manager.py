"""Docker container lifecycle management for per-user openclaw instances."""

from __future__ import annotations

import secrets
from pathlib import Path

import docker
from docker.errors import APIError as DockerAPIError, NotFound as DockerNotFound
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
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
            internal=False,  # allow internet access for tool downloads
        )


async def get_container(db: AsyncSession, user_id: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.user_id == user_id))
    return result.scalar_one_or_none()


async def get_container_by_token(db: AsyncSession, token: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.container_token == token))
    return result.scalar_one_or_none()


async def create_container(db: AsyncSession, user_id: str) -> Container:
    """Create a Docker container for a user and record metadata in DB.

    Inserts a DB record first to claim the user_id slot (preventing races),
    then creates the Docker container and updates the record.
    """
    container_token = secrets.token_urlsafe(32)
    short_id = user_id[:8]

    # Insert DB record first to claim the unique user_id slot.
    # If another request races us, the IntegrityError happens here
    # BEFORE we create any Docker resources.
    record = Container(
        user_id=user_id,
        docker_id="",
        container_token=container_token,
        status="creating",
        internal_host="",
        internal_port=18080,
    )
    db.add(record)
    await db.flush()  # raises IntegrityError on duplicate user_id

    # Now safe to create Docker resources — we hold the DB slot.
    _ensure_network()
    client = _docker()

    workspace_vol = f"openclaw-workspace-{short_id}"
    sessions_vol = f"openclaw-sessions-{short_id}"
    container_name = f"openclaw-user-{short_id}"

    # Remove any stale container with the same name
    try:
        stale = client.containers.get(container_name)
        stale.remove(force=True)
    except DockerNotFound:
        pass

    try:
        docker_container = client.containers.run(
            image=settings.openclaw_image,
            command=["node", "bridge/dist/start.js"],
            name=container_name,
            detach=True,
            environment={
                "NANOBOT_PROXY__URL": f"http://gateway:8080/llm/v1",
                "NANOBOT_PROXY__TOKEN": container_token,
                "NANOBOT_AGENTS__DEFAULTS__MODEL": settings.default_model,
            },
            mounts=[
                docker.types.Mount("/root/.openclaw/workspace", workspace_vol, type="volume"),
                docker.types.Mount("/root/.openclaw/sessions", sessions_vol, type="volume"),
            ],
            network=settings.container_network,
            mem_limit=settings.container_memory_limit,
            nano_cpus=int(settings.container_cpu_limit * 1e9),
            pids_limit=settings.container_pids_limit,
            restart_policy={"Name": "unless-stopped"},
        )
    except Exception:
        # Docker creation failed — remove the placeholder DB record
        await db.rollback()
        raise

    # Read container IP on the internal network
    docker_container.reload()
    network_settings = docker_container.attrs["NetworkSettings"]["Networks"]
    internal_ip = network_settings.get(settings.container_network, {}).get("IPAddress", "")

    record.docker_id = docker_container.id
    record.status = "running"
    record.internal_host = internal_ip
    await db.commit()
    await db.refresh(record)
    return record


async def ensure_running(db: AsyncSession, user_id: str) -> Container:
    """Return a running container for the user, creating or unpausing as needed."""
    import asyncio

    record = await get_container(db, user_id)

    if record is None:
        try:
            return await create_container(db, user_id)
        except IntegrityError:
            # Race condition: another request created the container first
            await db.rollback()
            record = await get_container(db, user_id)
            if record is not None:
                # Fall through to status handling below
                pass
            else:
                raise

    # Another request is still creating the container — wait for it
    if record.status == "creating":
        for _ in range(30):  # wait up to 60s
            await asyncio.sleep(2)
            await db.expire(record)
            record = await get_container(db, user_id)
            if record is None or record.status != "creating":
                break
        if record is None:
            return await create_container(db, user_id)
        if record.status == "creating":
            raise RuntimeError("Container creation timed out")

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
            try:
                return await create_container(db, user_id)
            except IntegrityError:
                await db.rollback()
                record = await get_container(db, user_id)
                if record is not None:
                    return record
                raise

    elif record.status == "archived":
        # Recreate from persisted data volumes
        await db.delete(record)
        await db.commit()
        try:
            return await create_container(db, user_id)
        except IntegrityError:
            await db.rollback()
            record = await get_container(db, user_id)
            if record is not None:
                return record
            raise

    elif record.status == "running":
        # Verify it's actually running
        try:
            c = client.containers.get(record.docker_id)
            if c.status != "running":
                c.start()
        except DockerNotFound:
            await db.delete(record)
            await db.commit()
            try:
                return await create_container(db, user_id)
            except IntegrityError:
                await db.rollback()
                record = await get_container(db, user_id)
                if record is not None:
                    return record
                raise

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
