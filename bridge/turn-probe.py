#!/usr/bin/env python3
"""Mac-side TURN reachability probe.

Sends a real TURN Allocate request to the bridge's coturn over TCP and checks
whether coturn's reply comes back through Docker Desktop's port-forward — no
browser involved. Run on the Mac (the Docker host):

    python3 bridge/turn-probe.py            # defaults to 127.0.0.1:3478
    python3 bridge/turn-probe.py 127.0.0.1 3478

Interpreting the result:
  RESPONSE ... type 0x0113 ... OK   -> coturn is reachable from the Mac; the only
                                       thing that still can't connect is the
                                       browser  => browser-security block (CSP /
                                       Private Network Access in the sidebar).
  TIMEOUT                           -> Docker Desktop's TCP proxy is NOT returning
                                       coturn's reply => a Docker-networking issue.
"""
import os
import socket
import struct
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 3478

MAGIC = 0x2112A442
# One attribute: REQUESTED-TRANSPORT (0x0019), value = UDP (17).
attr = struct.pack(">HH", 0x0019, 4) + bytes([17, 0, 0, 0])
# STUN/TURN Allocate request: type 0x0003, length = len(attr), magic, txid.
msg = struct.pack(">HHI", 0x0003, len(attr), MAGIC) + os.urandom(12) + attr

print(f"probing TURN at {HOST}:{PORT} (TCP) ...")
s = socket.socket()
s.settimeout(4)
try:
    s.connect((HOST, PORT))
    s.sendall(msg)
    data = s.recv(1024)
    if data and len(data) >= 2:
        mt = struct.unpack(">H", data[:2])[0]
        verdict = "OK ✓ (0x0113 = Allocate error/401 = coturn answered)" if mt in (0x0113, 0x0103) \
            else "got a STUN reply"
        print(f"RESPONSE: {len(data)} bytes, STUN type 0x{mt:04x} -> proxy forwards TURN-over-TCP {verdict}")
        print(">> coturn IS reachable from the Mac. The browser is the only blocker -> browser security (CSP/PNA).")
    else:
        print("EMPTY response (connection opened but no data).")
except socket.timeout:
    print("TIMEOUT -> Docker Desktop's TCP proxy did NOT return coturn's reply.")
    print(">> This is a Docker-networking issue, not the browser.")
except ConnectionRefusedError:
    print("CONNECTION REFUSED -> nothing is listening on the host's port (is -p 3478:3478/tcp published?).")
except Exception as e:  # noqa: BLE001
    print("ERROR:", e)
finally:
    s.close()
