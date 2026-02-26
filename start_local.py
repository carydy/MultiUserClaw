#!/usr/bin/env python3
"""Nanobot 本地开发启动脚本。

一键启动所有本地开发服务：
  1. PostgreSQL (Docker 容器, 端口 5432)
  2. nanobot web 后端 (端口 18080)
  3. platform gateway (端口 8080)
  4. frontend dev server (端口 3080)

用法:
  # 启动所有服务
  python start_local.py

  # 仅启动部分服务
  python start_local.py --only db,gateway,frontend

  # 跳过某些服务
  python start_local.py --skip nanobot

  # 指定 nanobot config
  python start_local.py --nanobot-config ~/.nanobot/config.json

  # 停止所有服务
  python start_local.py --stop
"""

import argparse
import os
import signal
import subprocess
import sys
import time

# ── 颜色输出 ──────────────────────────────────────────────────────────
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# ── 服务配置 ──────────────────────────────────────────────────────────
SERVICES = {
    "db": {
        "name": "PostgreSQL",
        "port": 5432,
        "color": "\033[34m",  # blue
    },
    "nanobot": {
        "name": "Nanobot Web",
        "port": 18080,
        "color": "\033[35m",  # magenta
    },
    "gateway": {
        "name": "Platform Gateway",
        "port": 8080,
        "color": "\033[36m",  # cyan
    },
    "frontend": {
        "name": "Frontend Dev",
        "port": 3080,
        "color": "\033[33m",  # yellow
    },
}


def log(msg: str, color: str = CYAN):
    print(f"{color}{BOLD}▸{RESET} {msg}")


def success(msg: str):
    print(f"{GREEN}✓{RESET} {msg}")


def error(msg: str):
    print(f"{RED}✗{RESET} {msg}")


def warn(msg: str):
    print(f"{YELLOW}⚠{RESET} {msg}")


def is_port_in_use(port: int) -> bool:
    """检查端口是否被占用。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_for_port(port: int, timeout: int = 30, name: str = "") -> bool:
    """等待端口可用。"""
    for i in range(timeout):
        if is_port_in_use(port):
            return True
        time.sleep(1)
        sys.stdout.write(f"\r  等待 {name or f'端口 {port}'}... ({i + 1}/{timeout}s)")
        sys.stdout.flush()
    print()
    return False


def start_postgres() -> bool:
    """启动 PostgreSQL Docker 容器。"""
    log("启动 PostgreSQL...")

    # 检查是否已有容器在运行
    result = subprocess.run(
        ["docker", "ps", "-q", "--filter", "name=^nanobot-local-postgres$"],
        capture_output=True, text=True,
    )
    if result.stdout.strip():
        success("PostgreSQL 已在运行")
        return True

    # 检查是否有已停止的容器
    result = subprocess.run(
        ["docker", "ps", "-aq", "--filter", "name=^nanobot-local-postgres$"],
        capture_output=True, text=True,
    )
    if result.stdout.strip():
        log("启动已有的 PostgreSQL 容器...")
        subprocess.run(["docker", "start", "nanobot-local-postgres"], check=True)
    else:
        log("创建新的 PostgreSQL 容器...")
        subprocess.run([
            "docker", "run", "-d",
            "--name", "nanobot-local-postgres",
            "-e", "POSTGRES_USER=nanobot",
            "-e", "POSTGRES_PASSWORD=nanobot",
            "-e", "POSTGRES_DB=nanobot_platform",
            "-v", "nanobot-local-pgdata:/var/lib/postgresql/data",
            "-p", "5432:5432",
            "postgres:16-alpine",
        ], check=True)

    if wait_for_port(5432, timeout=15, name="PostgreSQL"):
        success("PostgreSQL 就绪 (端口 5432)")
        return True
    else:
        error("PostgreSQL 启动超时")
        return False


def stop_postgres():
    """停止 PostgreSQL 容器。"""
    subprocess.run(["docker", "stop", "nanobot-local-postgres"], capture_output=True)
    success("PostgreSQL 已停止")


def start_nanobot_web(env: dict) -> subprocess.Popen | None:
    """启动 nanobot web 后端。"""
    log("启动 Nanobot Web 后端 (端口 18080)...")

    if is_port_in_use(18080):
        warn("端口 18080 已被占用，跳过 nanobot web")
        return None

    proc_env = {**os.environ, **env}
    proc = subprocess.Popen(
        ["nanobot", "web", "--port", "18080", "--host", "0.0.0.0"],
        cwd=PROJECT_DIR,
        env=proc_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    log(f"  PID: {proc.pid}")
    return proc


def start_gateway(env: dict) -> subprocess.Popen | None:
    """启动 platform gateway。"""
    log("启动 Platform Gateway (端口 8080)...")

    if is_port_in_use(8080):
        warn("端口 8080 已被占用，跳过 gateway")
        return None

    proc_env = {
        **os.environ,
        "PLATFORM_DATABASE_URL": "postgresql+asyncpg://nanobot:nanobot@localhost:5432/nanobot_platform",
        **env,
    }

    # 从项目根目录 .env 读取 API Key 并注入
    env_path = os.path.join(PROJECT_DIR, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip()
                    # 将根目录的 KEY 映射为 PLATFORM_ 前缀
                    if key.endswith("_API_KEY"):
                        platform_key = f"PLATFORM_{key}"
                        if platform_key not in proc_env:
                            proc_env[platform_key] = val

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"],
        cwd=os.path.join(PROJECT_DIR, "platform"),
        env=proc_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    log(f"  PID: {proc.pid}")
    return proc


def start_frontend() -> subprocess.Popen | None:
    """启动 frontend dev server。"""
    log("启动 Frontend Dev Server (端口 3080)...")

    if is_port_in_use(3080):
        warn("端口 3080 已被占用，跳过 frontend")
        return None

    # 检查 node_modules
    nm_path = os.path.join(PROJECT_DIR, "frontend", "node_modules")
    if not os.path.exists(nm_path):
        log("安装前端依赖...")
        subprocess.run(["npm", "install"], cwd=os.path.join(PROJECT_DIR, "frontend"), check=True)

    proc_env = {
        **os.environ,
        "NEXT_PUBLIC_API_URL": "http://127.0.0.1:8080",
    }
    proc = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=os.path.join(PROJECT_DIR, "frontend"),
        env=proc_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    log(f"  PID: {proc.pid}")
    return proc


def tail_output(procs: dict[str, subprocess.Popen]):
    """实时输出所有进程的日志，带颜色前缀。"""
    import selectors

    sel = selectors.DefaultSelector()
    fd_to_name = {}

    for name, proc in procs.items():
        if proc and proc.stdout:
            os.set_blocking(proc.stdout.fileno(), False)
            sel.register(proc.stdout, selectors.EVENT_READ, name)
            fd_to_name[proc.stdout.fileno()] = name

    try:
        while True:
            # 检查进程是否还活着
            alive = any(p.poll() is None for p in procs.values() if p)
            if not alive:
                break

            events = sel.select(timeout=1)
            for key, _ in events:
                name = key.data
                svc = SERVICES.get(name, {})
                color = svc.get("color", CYAN)
                line = key.fileobj.readline()
                if line:
                    text = line.decode("utf-8", errors="replace").rstrip()
                    print(f"{color}[{name:>8}]{RESET} {text}")
    except KeyboardInterrupt:
        pass
    finally:
        sel.close()


def stop_all():
    """停止所有本地服务。"""
    log("停止所有本地服务...")

    # 停止 postgres 容器
    stop_postgres()

    # 查找并终止相关进程
    patterns = [
        "nanobot web",
        "uvicorn app.main:app",
        "next dev.*3080",
    ]
    for pattern in patterns:
        result = subprocess.run(
            f"pgrep -f '{pattern}'",
            shell=True, capture_output=True, text=True,
        )
        pids = result.stdout.strip().split("\n")
        for pid in pids:
            if pid:
                try:
                    os.kill(int(pid), signal.SIGTERM)
                    log(f"  终止进程 {pid} ({pattern})")
                except (ProcessLookupError, ValueError):
                    pass

    success("所有服务已停止")


def main():
    parser = argparse.ArgumentParser(
        description="Nanobot 本地开发启动脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--stop", action="store_true", help="停止所有本地服务")
    parser.add_argument(
        "--only", type=str, default=None,
        help="仅启动指定服务，逗号分隔 (db,nanobot,gateway,frontend)",
    )
    parser.add_argument(
        "--skip", type=str, default=None,
        help="跳过指定服务，逗号分隔 (db,nanobot,gateway,frontend)",
    )
    parser.add_argument("--no-tail", action="store_true", help="不跟踪日志输出")
    args = parser.parse_args()

    if args.stop:
        stop_all()
        return

    # 解析要启动的服务
    all_services = ["db", "nanobot", "gateway", "frontend"]
    if args.only:
        enabled = [s.strip() for s in args.only.split(",")]
    else:
        enabled = list(all_services)

    if args.skip:
        skip = {s.strip() for s in args.skip.split(",")}
        enabled = [s for s in enabled if s not in skip]

    print(f"\n{BOLD}🔧 Nanobot 本地开发环境{RESET}\n")
    log(f"启动服务: {', '.join(enabled)}")

    processes: dict[str, subprocess.Popen | None] = {}
    extra_env: dict[str, str] = {}

    try:
        # 1. PostgreSQL
        if "db" in enabled:
            # 检查 docker
            result = subprocess.run("docker info", shell=True, capture_output=True)
            if result.returncode != 0:
                error("Docker 未运行，无法启动 PostgreSQL")
                error("请先启动 Docker，或使用 --skip db 跳过")
                sys.exit(1)
            if not start_postgres():
                sys.exit(1)

        # 2. Nanobot Web 后端
        if "nanobot" in enabled:
            proc = start_nanobot_web(extra_env)
            if proc:
                processes["nanobot"] = proc

        # 3. Platform Gateway
        if "gateway" in enabled:
            proc = start_gateway(extra_env)
            if proc:
                processes["gateway"] = proc

        # 短暂等待 gateway 启动，frontend 依赖它
        if "gateway" in enabled and "frontend" in enabled:
            time.sleep(2)

        # 4. Frontend
        if "frontend" in enabled:
            proc = start_frontend()
            if proc:
                processes["frontend"] = proc

        if not processes:
            success("所有服务已就绪（使用已有实例）")
            return

        # 打印访问信息
        print(f"\n{BOLD}{'=' * 50}{RESET}")
        print(f"{BOLD}  本地开发环境已启动{RESET}")
        print(f"{'=' * 50}")
        for svc_id in enabled:
            svc = SERVICES[svc_id]
            status = "Docker 容器" if svc_id == "db" else f"PID {processes.get(svc_id, {!r: 'N/A'})}"
            if svc_id == "db":
                pid_info = "Docker 容器"
            elif svc_id in processes and processes[svc_id]:
                pid_info = f"PID {processes[svc_id].pid}"
            else:
                pid_info = "已有实例"
            print(f"  {svc['color']}{svc['name']:>20}{RESET}  http://127.0.0.1:{svc['port']}  ({pid_info})")
        print(f"{'=' * 50}")
        print(f"  {DIM}按 Ctrl+C 停止所有服务{RESET}\n")

        # 跟踪日志
        if not args.no_tail:
            tail_output(processes)
        else:
            # 等待所有进程
            for proc in processes.values():
                if proc:
                    proc.wait()

    except KeyboardInterrupt:
        print(f"\n\n{YELLOW}正在停止服务...{RESET}")
    finally:
        # 清理进程
        for name, proc in processes.items():
            if proc and proc.poll() is None:
                log(f"停止 {name} (PID {proc.pid})...")
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

        # 如果启动了 db，也停止它
        if "db" in enabled:
            stop_postgres()

        success("所有服务已停止")


if __name__ == "__main__":
    main()
