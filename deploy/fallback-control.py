#!/usr/bin/python3
import hmac
import json
import os
import subprocess
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def run(*args, timeout=180):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, timeout=timeout)


SWITCH_LOCK = threading.Lock()


def healthy(port):
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def switch_uncensored():
    if healthy(8081):
        return 200, {"ok": True, "alreadyActive": True}
    if healthy(8080):
        stopped = run("systemctl", "stop", "llama-server", timeout=90)
        if stopped.returncode != 0:
            return 503, {"ok": False, "error": stopped.stdout.strip()}
    else:
        stopped = run("systemctl", "stop", "llama-server", timeout=90)

    for _ in range(30):
        used = run("sh", "-c",
                   "cat /sys/class/drm/card*/device/mem_info_gtt_used 2>/dev/null | sort -nr | head -1")
        try:
            gtt = int(used.stdout.strip()) if used.stdout.strip() else 0
        except ValueError:
            gtt = 0
        if gtt < 15 * 1024 * 1024 * 1024:
            break
        time.sleep(1)

    started = run("systemctl", "restart", "llama-uncensored")
    if started.returncode != 0:
        run("systemctl", "restart", "llama-server")
        return 503, {"ok": False, "error": started.stdout.strip()}

    for _ in range(90):
        try:
            import urllib.request
            with urllib.request.urlopen("http://127.0.0.1:8081/health", timeout=2) as response:
                if response.status == 200:
                    return 200, {"ok": True}
        except Exception:
            pass
        time.sleep(2)
    return 503, {"ok": False, "error": "uncensored llama-server did not become healthy"}


def switch_qwen():
    if healthy(8080):
        return 200, {"ok": True, "alreadyActive": True}
    if healthy(8081):
        stopped = run("systemctl", "stop", "llama-uncensored", timeout=90)
        if stopped.returncode != 0:
            return 503, {"ok": False, "error": stopped.stdout.strip()}

    for _ in range(30):
        used = run("sh", "-c",
                   "cat /sys/class/drm/card*/device/mem_info_gtt_used 2>/dev/null | sort -nr | head -1")
        try:
            gtt = int(used.stdout.strip()) if used.stdout.strip() else 0
        except ValueError:
            gtt = 0
        if gtt < 15 * 1024 * 1024 * 1024:
            break
        time.sleep(1)

    started = run("systemctl", "restart", "llama-server")
    if started.returncode != 0:
        return 503, {"ok": False, "error": started.stdout.strip()}
    for _ in range(90):
        if healthy(8080):
            return 200, {"ok": True}
        time.sleep(2)
    return 503, {"ok": False, "error": "Qwen llama-server did not become healthy"}


def stop_llama():
    stopped_qwen = run("systemctl", "stop", "llama-server", timeout=90)
    stopped_uncensored = run("systemctl", "stop", "llama-uncensored", timeout=90)
    if stopped_qwen.returncode != 0 and healthy(8080):
        return 503, {"ok": False, "error": stopped_qwen.stdout.strip()}
    if stopped_uncensored.returncode != 0 and healthy(8081):
        return 503, {"ok": False, "error": stopped_uncensored.stdout.strip()}

    for _ in range(30):
        used = run("sh", "-c",
                   "cat /sys/class/drm/card*/device/mem_info_gtt_used 2>/dev/null | sort -nr | head -1")
        try:
            gtt = int(used.stdout.strip()) if used.stdout.strip() else 0
        except ValueError:
            gtt = 0
        if not healthy(8080) and not healthy(8081) and gtt < 15 * 1024 * 1024 * 1024:
            return 200, {"ok": True, "stopped": True}
        time.sleep(1)

    return 503, {"ok": False, "error": "llama-server ports or GTT did not release in time"}


PORT = int(os.environ.get("FALLBACK_CONTROL_PORT", "8082"))
TOKEN_FILE = os.environ.get("FALLBACK_CONTROL_TOKEN_FILE", "/opt/llama-server/fallback-token")


def expected_token():
    """Shared secret the app must send. No token file means no auth (backward compatible)."""
    try:
        with open(TOKEN_FILE) as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def bind_addresses():
    """Loopback plus the Docker bridge gateway (host.docker.internal) - never the LAN."""
    extra = os.environ.get("FALLBACK_CONTROL_BIND", "").split()
    if extra:
        return extra
    addrs = ["127.0.0.1"]
    out = run("sh", "-c", "ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1", timeout=5)
    docker_ip = out.stdout.strip() or "172.17.0.1"
    addrs.append(docker_ip)
    return addrs


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path not in ("/switch-uncensored", "/switch-qwen", "/stop-llama", "/status"):
            self.send_error(404)
            return
        token = expected_token()
        if token and not hmac.compare_digest(self.headers.get("X-Fallback-Token", ""), token):
            self.send_error(401)
            return
        with SWITCH_LOCK:
            if self.path == "/switch-uncensored":
                status, body = switch_uncensored()
            elif self.path == "/switch-qwen":
                status, body = switch_qwen()
            elif self.path == "/stop-llama":
                status, body = stop_llama()
            else:
                status, body = 200, {
                    "qwen": healthy(8080),
                    "uncensored": healthy(8081),
                }
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        return


def serve(addr):
    # docker0 may not exist yet at boot; keep retrying instead of failing the whole service.
    while True:
        try:
            ThreadingHTTPServer((addr, PORT), Handler).serve_forever()
        except OSError:
            time.sleep(5)


if __name__ == "__main__":
    threads = [threading.Thread(target=serve, args=(a,), daemon=True) for a in bind_addresses()]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
