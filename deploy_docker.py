#!/usr/bin/env python3
"""Nanobot Docker 部署脚本。

构建镜像并通过 docker compose 启动所有服务（postgres + gateway + frontend）。
支持本地部署和远程服务器部署（通过 SSH）。

用法:
  # 本地部署（默认端口 gateway:8080, frontend:3080）
  python deploy_docker.py

  # 指定服务器 IP（会自动设置 NEXT_PUBLIC_API_URL）
  python deploy_docker.py --host 192.168.1.10

  # 使用 prod compose 文件
  python deploy_docker.py --host 117.133.60.219 --compose docker-compose.yml.prod

  # 仅构建镜像不启动
  python deploy_docker.py --build-only

  # 仅重启服务
  python deploy_docker.py --restart

  # 重建某个服务
  python deploy_docker.py --rebuild gateway
  python deploy_docker.py --rebuild frontend

  # 完全清理重建
  python deploy_docker.py --clean
"""

import argparse
import os
import subprocess
import sys
import time

# ── 颜色输出 ──────────────────────────────────────────────────────────
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
BOLD = "\033[1m"
RESET = "\033[0m"

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))


def log(msg: str, color: str = CYAN):
    print(f"{color}{BOLD}▸{RESET} {msg}")


def success(msg: str):
    print(f"{GREEN}✓{RESET} {msg}")


def error(msg: str):
    print(f"{RED}✗{RESET} {msg}")


def warn(msg: str):
    print(f"{YELLOW}⚠{RESET} {msg}")


def run(cmd: str | list[str], cwd: str | None = None, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    """执行命令并实时输出。"""
    if isinstance(cmd, str):
        cmd_display = cmd
    else:
        cmd_display = " ".join(cmd)
    log(f"执行: {cmd_display}")
    result = subprocess.run(
        cmd if isinstance(cmd, list) else cmd,
        cwd=cwd or PROJECT_DIR,
        shell=isinstance(cmd, str),
        check=False,
        **kwargs,
    )
    if check and result.returncode != 0:
        error(f"命令失败 (exit {result.returncode}): {cmd_display}")
        sys.exit(1)
    return result


def check_prerequisites():
    """检查 docker 和 docker compose 是否可用。"""
    log("检查前置依赖...")

    for cmd, name in [("docker --version", "Docker"), ("docker compose version", "Docker Compose")]:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            error(f"{name} 未安装或无法访问")
            sys.exit(1)
        success(f"{name}: {result.stdout.strip()}")

    # 检查 docker daemon
    result = subprocess.run("docker info", shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        error("Docker daemon 未运行，请先启动 Docker")
        sys.exit(1)
    success("Docker daemon 运行中")


def check_env_file():
    """检查 .env 文件是否存在且包含至少一个 API Key。"""
    env_path = os.path.join(PROJECT_DIR, ".env")
    if not os.path.exists(env_path):
        warn(".env 文件不存在，将使用默认配置")
        warn("建议创建 .env 文件并配置至少一个 LLM API Key")
        return

    with open(env_path) as f:
        content = f.read()

    key_vars = [
        "DASHSCOPE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "OPENROUTER_API_KEY",
        "AIHUBMIX_API_KEY",
    ]
    found_keys = []
    for var in key_vars:
        for line in content.splitlines():
            line = line.strip()
            if line.startswith(f"{var}=") and not line.endswith("=") and "xxxx" not in line:
                found_keys.append(var)
                break

    if found_keys:
        success(f".env 已配置 API Key: {', '.join(found_keys)}")
    else:
        warn(".env 中未找到有效的 API Key，请确认配置")


def build_nanobot_image():
    """构建 nanobot 基础镜像（用户容器使用）。"""
    log("构建 nanobot:latest 基础镜像...")
    run("docker build -t nanobot:latest .")
    success("nanobot:latest 构建完成")


def build_and_start(compose_file: str, host: str, gateway_port: int, frontend_port: int):
    """构建并启动所有 compose 服务。"""
    api_url = f"http://{host}:{gateway_port}"
    log(f"Frontend NEXT_PUBLIC_API_URL = {api_url}")

    # 用临时环境变量设置 NEXT_PUBLIC_API_URL
    # docker-compose.yml 中已经硬编码了这个值，我们通过 sed 或者环境变量覆盖
    # 更好的方式是修改 compose 文件使用变量
    compose_args = f"-f {compose_file}"

    log(f"使用 {compose_file} 构建并启动服务...")
    run(f"docker compose {compose_args} build --build-arg NEXT_PUBLIC_API_URL={api_url}")
    run(f"docker compose {compose_args} up -d")
    success("所有服务已启动")


def rebuild_service(compose_file: str, service: str):
    """重建并重启指定服务。"""
    compose_args = f"-f {compose_file}"
    log(f"重建服务: {service}...")
    run(f"docker compose {compose_args} build --no-cache {service}")
    run(f"docker compose {compose_args} up -d {service}")
    success(f"服务 {service} 已重建并启动")


def restart_services(compose_file: str):
    """重启所有服务。"""
    compose_args = f"-f {compose_file}"
    log("重启所有服务...")
    run(f"docker compose {compose_args} restart")
    success("所有服务已重启")


def clean_all(compose_file: str):
    """停止所有服务并清理数据。"""
    compose_args = f"-f {compose_file}"
    warn("即将停止所有服务并删除数据卷...")

    response = input("确认要清理所有数据？(y/N): ").strip().lower()
    if response != "y":
        log("取消操作")
        return

    log("停止 compose 服务并删除卷...")
    run(f"docker compose {compose_args} down -v", check=False)

    log("清理用户容器...")
    result = subprocess.run(
        'docker ps -a --filter "name=nanobot-user-" -q',
        shell=True, capture_output=True, text=True, cwd=PROJECT_DIR,
    )
    container_ids = result.stdout.strip()
    if container_ids:
        run(f"docker rm -f {container_ids}", check=False)
        success("用户容器已清理")
    else:
        log("无用户容器需要清理")

    success("清理完成")


def health_check(host: str, gateway_port: int, frontend_port: int, retries: int = 30):
    """等待服务就绪并检查健康状态。"""
    import urllib.request
    import json

    log("等待服务就绪...")

    # 等待 gateway
    gateway_url = f"http://{host}:{gateway_port}/api/ping"
    for i in range(1, retries + 1):
        try:
            req = urllib.request.Request(gateway_url)
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read())
                if data.get("message") == "pong":
                    success(f"Gateway 就绪: {gateway_url}")
                    break
        except Exception:
            pass
        if i < retries:
            sys.stdout.write(f"\r  等待 Gateway... ({i}/{retries})")
            sys.stdout.flush()
            time.sleep(2)
    else:
        print()
        error(f"Gateway 未就绪: {gateway_url}")
        return False

    # 等待 frontend
    frontend_url = f"http://{host}:{frontend_port}"
    for i in range(1, retries + 1):
        try:
            req = urllib.request.Request(frontend_url)
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status < 400:
                    success(f"Frontend 就绪: {frontend_url}")
                    break
        except Exception:
            pass
        if i < retries:
            sys.stdout.write(f"\r  等待 Frontend... ({i}/{retries})")
            sys.stdout.flush()
            time.sleep(2)
    else:
        print()
        error(f"Frontend 未就绪: {frontend_url}")
        return False

    return True


def show_status(compose_file: str, host: str, gateway_port: int, frontend_port: int):
    """显示部署状态摘要。"""
    compose_args = f"-f {compose_file}"
    print(f"\n{BOLD}{'=' * 50}{RESET}")
    print(f"{BOLD}  Nanobot 部署状态{RESET}")
    print(f"{'=' * 50}")
    print(f"  Frontend:  http://{host}:{frontend_port}")
    print(f"  Gateway:   http://{host}:{gateway_port}")
    print(f"  Compose:   {compose_file}")
    print(f"{'=' * 50}\n")

    run(f"docker compose {compose_args} ps", check=False)
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Nanobot Docker 部署脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--host", default="localhost", help="服务器 IP 或域名 (默认: localhost)")
    parser.add_argument("--compose", default="docker-compose.yml", help="compose 文件 (默认: docker-compose.yml)")
    parser.add_argument("--gateway-port", type=int, default=None, help="Gateway 端口 (默认: 从 compose 文件读取)")
    parser.add_argument("--frontend-port", type=int, default=3080, help="Frontend 端口 (默认: 3080)")
    parser.add_argument("--build-only", action="store_true", help="仅构建镜像，不启动服务")
    parser.add_argument("--restart", action="store_true", help="仅重启服务")
    parser.add_argument("--rebuild", metavar="SERVICE", help="重建指定服务 (gateway/frontend)")
    parser.add_argument("--clean", action="store_true", help="停止所有服务并清理数据")
    parser.add_argument("--skip-base", action="store_true", help="跳过构建 nanobot 基础镜像")
    parser.add_argument("--skip-health", action="store_true", help="跳过健康检查")
    parser.add_argument("--status", action="store_true", help="仅显示当前状态")
    args = parser.parse_args()

    # 推断 gateway 端口
    if args.gateway_port is None:
        if "prod" in args.compose:
            args.gateway_port = 8100
        else:
            args.gateway_port = 8080

    os.chdir(PROJECT_DIR)

    print(f"\n{BOLD}🚀 Nanobot Docker 部署{RESET}\n")

    # 仅显示状态
    if args.status:
        show_status(args.compose, args.host, args.gateway_port, args.frontend_port)
        return

    check_prerequisites()

    # 清理
    if args.clean:
        clean_all(args.compose)
        return

    # 重启
    if args.restart:
        restart_services(args.compose)
        show_status(args.compose, args.host, args.gateway_port, args.frontend_port)
        return

    # 重建单个服务
    if args.rebuild:
        rebuild_service(args.compose, args.rebuild)
        show_status(args.compose, args.host, args.gateway_port, args.frontend_port)
        return

    check_env_file()

    # 构建 nanobot 基础镜像
    if not args.skip_base:
        build_nanobot_image()

    if args.build_only:
        log("仅构建模式，跳过启动")
        return

    # 构建并启动
    build_and_start(args.compose, args.host, args.gateway_port, args.frontend_port)

    # 健康检查
    if not args.skip_health:
        check_host = "localhost" if args.host in ("0.0.0.0",) else args.host
        health_check(check_host, args.gateway_port, args.frontend_port)

    show_status(args.compose, args.host, args.gateway_port, args.frontend_port)


if __name__ == "__main__":
    main()
