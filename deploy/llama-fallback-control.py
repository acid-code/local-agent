#!/usr/bin/python3
import json
import subprocess
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


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


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path not in ("/switch-uncensored", "/switch-qwen", "/status"):
            self.send_error(404)
            return
        with SWITCH_LOCK:
            if self.path == "/switch-uncensored":
                status, body = switch_uncensored()
            elif self.path == "/switch-qwen":
                status, body = switch_qwen()
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


HTTPServer(("0.0.0.0", 8082), Handler).serve_forever()
