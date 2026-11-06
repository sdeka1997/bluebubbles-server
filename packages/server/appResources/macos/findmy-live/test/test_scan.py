#!/usr/bin/env python3
"""The bridge finds Find My's manager by itself within seconds of it appearing, with no scan delay set."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time

root = Path(__file__).resolve().parents[1]
build = root / "build"
sock_path = Path(f"/tmp/bbfm-scan-test-{os.getpid()}.sock")
token = "0123456789abcdef0123456789abcdef"
sock_path.unlink(missing_ok=True)
env = {k: v for k, v in os.environ.items() if k != "BBFM_LIVE_SCAN_DELAY_MS"} | {
    "BBFM_LIVE_TOKEN": token,
    "BBFM_LIVE_SOCKET": str(sock_path),
    "BBFM_TEST_LOG": str(build / "scan-calls.log"),
}
process = subprocess.Popen([str(build / "host_scan")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def request(body):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(str(sock_path))
        client.sendall((json.dumps(body) + "\n").encode())
        return json.loads(client.recv(4096))


try:
    started = time.monotonic()
    reply = None
    while time.monotonic() - started < 4:
        if sock_path.exists():
            reply = request({"token": token, "command": "start", "id": "friend-two"})
            if reply == {"status": "ok"}:
                break
        time.sleep(0.1)
    took = time.monotonic() - started
    assert reply == {"status": "ok"}, f"manager not found within 4 s: {reply}"
    print(f"bridge scan: PASS (found in {took:.1f} s)")
finally:
    process.terminate()
    process.wait(timeout=5)
