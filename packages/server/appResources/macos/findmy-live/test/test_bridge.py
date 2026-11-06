#!/usr/bin/env python3
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import threading
import time

root = Path(__file__).resolve().parents[1]
build = root / "build"
sock_path = Path(f"/tmp/bbfm-bridge-test-{os.getpid()}.sock")
log_path = build / "calls.log"
token = "0123456789abcdef0123456789abcdef"

for path in (sock_path, log_path):
    path.unlink(missing_ok=True)

env = os.environ | {
    "BBFM_LIVE_TOKEN": token,
    "BBFM_LIVE_SOCKET": str(sock_path),
    "BBFM_LIVE_SCAN_DELAY_MS": "50",
    "BBFM_TEST_LOG": str(log_path),
}
process = subprocess.Popen([str(build / "host")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def request(body):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(str(sock_path))
        client.sendall((json.dumps(body) + "\n").encode())
        return json.loads(client.recv(4096))

def fragmented_request(body):
    encoded = (json.dumps(body) + "\n").encode()
    split = len(encoded) // 2
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(str(sock_path))
        client.sendall(encoded[:split])
        time.sleep(0.05)
        client.sendall(encoded[split:])
        return json.loads(client.recv(4096))

def raw_request(data):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(str(sock_path))
        client.sendall(data)
        return json.loads(client.recv(4096))


def drip_slowly(client):
    for _ in range(20):
        try:
            client.sendall(b" ")
        except (BrokenPipeError, OSError):
            return
        time.sleep(0.2)


def disconnect_before_reply(body):
    client = socket.socket(socket.AF_UNIX)
    client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    client.connect(str(sock_path))
    client.sendall((json.dumps(body) + "\n").encode())
    client.close()


def calls():
    return log_path.read_text().splitlines() if log_path.exists() else []


def action_calls():
    return [line for line in calls() if line.startswith(("START ", "STOP "))]

try:
    deadline = time.time() + 3
    while not sock_path.exists() and time.time() < deadline:
        if process.poll() is not None:
            stderr = process.stderr.read() if process.stderr else ""
            raise AssertionError(f"host exited early: {stderr}")
        time.sleep(0.02)
    assert sock_path.exists(), "bridge socket was not created"
    assert stat.S_IMODE(sock_path.stat().st_mode) == 0o600

    assert request({"token": "wrong", "command": "stop"}) == {"status": "error", "error": "unauthorized"}

    deadline = time.time() + 3
    reply = None
    while time.time() < deadline:
        reply = request({"token": token, "command": "stop"})
        if reply == {"status": "ok"}:
            break
        time.sleep(0.02)
    assert reply == {"status": "ok"}, reply
    assert fragmented_request({"token": token, "command": "stop"}) == {"status": "ok"}

    with socket.socket(socket.AF_UNIX) as idle:
        idle.connect(str(sock_path))
        time.sleep(1.2)
        assert request({"token": token, "command": "stop"}) == {"status": "ok"}

    with socket.socket(socket.AF_UNIX) as slow:
        slow.connect(str(sock_path))
        dripper = threading.Thread(target=drip_slowly, args=(slow,))
        dripper.start()
        time.sleep(0.1)
        started = time.monotonic()
        assert request({"token": token, "command": "stop"}) == {"status": "ok"}
        assert time.monotonic() - started < 1.8, "slow unauthenticated client monopolized the bridge"
        dripper.join()

    disconnect_before_reply({"token": token, "command": "stop"})
    time.sleep(0.1)
    assert process.poll() is None, "client disconnect killed the injected host"
    assert request({"token": token, "command": "stop"}) == {"status": "ok"}

    assert request({"token": token, "command": "start", "id": "missing"}) == {
        "status": "error", "error": "friend not found"
    }
    assert request({"token": token, "command": "start", "id": "One"}) == {
        "status": "error", "error": "friend not found"
    }
    assert request({"token": token, "command": "start", "id": 7}) == {
        "status": "error", "error": "unsupported command"
    }
    assert raw_request(b"not json\n") == {"status": "error", "error": "invalid request"}
    assert raw_request(b"{" + b"x" * 9000 + b"\n") == {"status": "error", "error": "invalid request"}
    assert request({"token": token, "command": "start", "id": "duplicate"}) == {
        "status": "error", "error": "friend id is not unique"
    }
    assert request({"token": token, "command": "start", "id": "friend-one"}) == {"status": "ok"}
    assert "FRIENDS main" in calls()
    assert action_calls() == ["START friend-one~~~ BlueBubbles main"]

    assert request({"token": token, "command": "start", "id": "friend-two"}) == {"status": "ok"}
    assert action_calls() == [
        "START friend-one~~~ BlueBubbles main",
        "STOP friend-one~~~ main",
        "START friend-two BlueBubbles main",
    ]

    assert request({"token": token, "command": "stop"}) == {"status": "ok"}
    assert action_calls()[-1] == "STOP friend-two main"
    stopped = action_calls()
    assert request({"token": token, "command": "stop"}) == {"status": "ok"}
    assert action_calls() == stopped, "stopping twice must not call Apple twice"
    assert request({"token": token, "command": "delete"}) == {
        "status": "error", "error": "unsupported command"
    }
finally:
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=2)

assert not sock_path.exists(), "bridge socket was not removed when its host exited"
print("bridge protocol: PASS")
