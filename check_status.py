#!/usr/bin/env python3
"""Nanobot platform health check script.

Checks all services: postgres, gateway, user containers (openclaw-bridge), frontend.
Usage: python check_status.py [--gateway http://localhost:8080]
"""

import argparse
import json
import subprocess
import sys

import httpx


def check_mark(ok: bool) -> str:
    return "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"


def run_cmd(cmd: list[str], timeout: int = 5) -> tuple[bool, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, str(e)


def check_docker_containers() -> dict[str, dict]:
    """Check status of all nanobot-related Docker containers."""
    ok, out = run_cmd([
        "docker", "ps", "-a",
        "--filter", "name=nanobot",
        "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}",
    ])
    results = {}
    if not ok or not out:
        return results
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            name, status = parts[0], parts[1]
            running = status.startswith("Up")
            results[name] = {"status": status, "running": running}
    return results


def find_postgres_container() -> str | None:
    """Find the postgres container name dynamically."""
    ok, out = run_cmd([
        "docker", "ps", "--filter", "name=postgres",
        "--format", "{{.Names}}",
    ])
    if ok and out:
        # Return first matching container
        return out.splitlines()[0] if out.splitlines() else None
    return None


def check_postgres() -> tuple[bool, str]:
    """Check PostgreSQL via docker exec."""
    container = find_postgres_container()
    if not container:
        return False, "PostgreSQL container not found"
    ok, out = run_cmd([
        "docker", "exec", container,
        "pg_isready", "-U", "nanobot", "-d", "nanobot_platform",
    ])
    return ok, out


def check_http(url: str, timeout: float = 5.0) -> tuple[bool, int | None, dict | str | None]:
    """GET an HTTP endpoint. Returns (ok, status_code, body)."""
    try:
        r = httpx.get(url, timeout=timeout)
        try:
            body = r.json()
        except Exception:
            body = r.text[:200]
        return r.status_code < 400, r.status_code, body
    except httpx.ConnectError:
        return False, None, "Connection refused"
    except httpx.TimeoutException:
        return False, None, "Timeout"
    except Exception as e:
        return False, None, str(e)


def check_gateway_ping(base: str) -> tuple[bool, str]:
    ok, code, body = check_http(f"{base}/api/ping")
    if ok and isinstance(body, dict) and body.get("message") == "pong":
        return True, "pong"
    return False, f"HTTP {code}: {body}"


def check_gateway_llm_proxy(base: str, token: str) -> tuple[bool, str]:
    """Check if the LLM proxy endpoint is reachable (auth will fail but endpoint should respond)."""
    try:
        r = httpx.post(
            f"{base}/llm/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": f"Bearer {token}"},
            timeout=5.0,
        )
        # 401/422 means the endpoint works (just bad auth/payload)
        if r.status_code in (401, 422):
            return True, f"Endpoint reachable (HTTP {r.status_code})"
        return False, f"HTTP {r.status_code}: {r.text[:100]}"
    except Exception as e:
        return False, str(e)


def check_user_containers() -> list[dict]:
    """Find and check running nanobot user containers."""
    ok, out = run_cmd([
        "docker", "ps",
        "--filter", "name=nanobot-user-",
        "--format", "{{.Names}}\t{{.Status}}",
    ])
    containers = []
    if not ok or not out:
        return containers
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        name, status = parts[0], parts[1]
        # Container is on internal network — use docker exec + node to check
        web_ok, web_out = run_cmd([
            "docker", "exec", name,
            "node", "-e",
            "fetch('http://localhost:18080/api/ping')"
            ".then(r=>r.json())"
            ".then(d=>{console.log(d.message);process.exit(0)})"
            ".catch(()=>process.exit(1))",
        ], timeout=10)
        web_ok = web_ok and "pong" in web_out
        containers.append({
            "name": name,
            "status": status,
            "web_ok": web_ok,
        })
    return containers


def check_frontend(url: str) -> tuple[bool, str]:
    """Check if the frontend is reachable."""
    try:
        r = httpx.get(url, timeout=5.0, follow_redirects=True)
        ok = r.status_code < 400
        return ok, f"HTTP {r.status_code}"
    except Exception as e:
        return False, str(e)


def main():
    parser = argparse.ArgumentParser(description="Nanobot platform health check")
    parser.add_argument("--gateway", default="http://localhost:8080", help="Gateway URL")
    parser.add_argument("--frontend", default="http://localhost:3080", help="Frontend URL")
    args = parser.parse_args()

    all_ok = True
    print("=== Nanobot Health Check ===\n")

    # 1. Docker containers
    print("Docker Containers:")
    containers = check_docker_containers()
    if not containers:
        print(f"  {check_mark(False)} No nanobot containers found")
        all_ok = False
    else:
        for name, info in sorted(containers.items()):
            ok = info["running"]
            if not ok:
                all_ok = False
            print(f"  {check_mark(ok)} {name}: {info['status']}")

    # 2. PostgreSQL
    print("\nPostgreSQL:")
    pg_ok, pg_msg = check_postgres()
    if not pg_ok:
        all_ok = False
    print(f"  {check_mark(pg_ok)} {pg_msg or 'not reachable'}")

    # 3. Gateway
    print(f"\nGateway ({args.gateway}):")
    gw_ok, gw_msg = check_gateway_ping(args.gateway)
    if not gw_ok:
        all_ok = False
    print(f"  {check_mark(gw_ok)} /api/ping: {gw_msg}")

    llm_ok, llm_msg = check_gateway_llm_proxy(args.gateway, "dummy-token")
    if not llm_ok:
        all_ok = False
    print(f"  {check_mark(llm_ok)} /llm/v1/chat/completions: {llm_msg}")

    # 4. User containers (internal web servers)
    print("\nUser Containers:")
    user_containers = check_user_containers()
    if not user_containers:
        print("  (none running)")
    for c in user_containers:
        ok = c["web_ok"]
        if not ok:
            all_ok = False
        web_info = "web OK" if c["web_ok"] else "web unreachable"
        print(f"  {check_mark(ok)} {c['name']}: {c['status']} ({web_info})")

    # 5. Frontend
    print(f"\nFrontend ({args.frontend}):")
    fe_ok, fe_msg = check_frontend(args.frontend)
    if not fe_ok:
        all_ok = False
    print(f"  {check_mark(fe_ok)} {fe_msg}")

    # Summary
    print(f"\n{'=' * 30}")
    if all_ok:
        print(f"{check_mark(True)} All checks passed")
    else:
        print(f"{check_mark(False)} Some checks failed")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
