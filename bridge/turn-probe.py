#!/usr/bin/env python3
"""Mac-side TURN reachability probe, with an HTTP control.

Run on the Mac (the Docker host):

    python3 bridge/turn-probe.py

It does two raw TCP round-trips through Docker's published ports:
  • CONTROL: GET /info on the bridge's 8787 (the port Local device already uses).
  • TEST:    a TURN Allocate on coturn's 3478.

Reading it:
  control OK  +  turn OK       -> coturn reachable from the Mac; browser is the
                                  only blocker => browser-security (CSP/PNA).
  control OK  +  turn TIMEOUT   -> the proxy round-trips TCP fine, but coturn isn't
                                  answering the proxied connection => coturn/Docker
                                  TURN-over-TCP issue (actionable on the bridge side).
  control TIMEOUT               -> the raw-probe method itself is unreliable here;
                                  we'll switch approach.
"""
import os
import socket
import struct
import sys

# Default to "localhost" (NOT 127.0.0.1): on Docker Desktop for Mac the IPv4
# 127.0.0.1 published-port path can hang while localhost (IPv6 ::1) works.
# create_connection() also tries both families, like the browser does.
HOST = sys.argv[1] if len(sys.argv) > 1 else "localhost"


def http_control(host: str, port: int = 8787) -> str:
    try:
        s = socket.create_connection((host, port), timeout=4)
    except socket.timeout:
        return "TIMEOUT (connect)"
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    try:
        s.settimeout(4)
        s.sendall(b"GET /info HTTP/1.0\r\nHost: localhost\r\n\r\n")
        data = s.recv(64)
        return f"OK — {data[:16]!r}" if data else "EMPTY (no data)"
    except socket.timeout:
        return "TIMEOUT (no reply)"
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    finally:
        s.close()


def turn_test(host: str, port: int = 3478) -> str:
    MAGIC = 0x2112A442
    attr = struct.pack(">HH", 0x0019, 4) + bytes([17, 0, 0, 0])  # REQUESTED-TRANSPORT=UDP
    msg = struct.pack(">HHI", 0x0003, len(attr), MAGIC) + os.urandom(12) + attr  # Allocate
    try:
        s = socket.create_connection((host, port), timeout=4)
    except socket.timeout:
        return "TIMEOUT (connect)"
    except ConnectionRefusedError:
        return "REFUSED (nothing listening on the host port)"
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    try:
        s.settimeout(4)
        s.sendall(msg)
        data = s.recv(1024)
        if data and len(data) >= 2:
            mt = struct.unpack(">H", data[:2])[0]
            return f"OK — {len(data)} bytes, STUN type 0x{mt:04x} (coturn answered)"
        return "EMPTY (connected, no data)"
    except socket.timeout:
        return "TIMEOUT (connected, no reply)"
    except ConnectionRefusedError:
        return "REFUSED (nothing listening on the host port)"
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    finally:
        s.close()


print(f"control  HTTP {HOST}:8787 -> {http_control(HOST)}")
print(f"test     TURN {HOST}:3478 -> {turn_test(HOST)}")
