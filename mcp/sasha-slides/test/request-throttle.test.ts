/**
 * The sliding-window throttle and the client address it is keyed by.
 *
 *   node --test --import tsx mcp/sasha-slides/test/request-throttle.test.ts
 */
import { strict as assert } from "node:assert";
import type { IncomingHttpHeaders } from "node:http";
import { describe, test } from "node:test";
import { clientAddress, LOOPBACK_PROXIES, parseTrustedProxies } from "../http/client-address";
import { createThrottle, type ThrottleRule } from "../http/request-throttle";

const THREE_PER_SECOND: ThrottleRule = { name: "three per second", limit: 3, windowMs: 1000 };
const FIVE_PER_MINUTE: ThrottleRule = { name: "five per minute", limit: 5, windowMs: 60_000 };

function clock(): Readonly<{ now: () => Date; advance: (milliseconds: number) => void }> {
  let nowMs = 1_000_000;
  return {
    now: () => new Date(nowMs),
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

describe("sliding-window throttle", () => {
  test("admits up to the limit, refuses the next with the time until a slot frees, and slides", () => {
    const time = clock();
    const throttle = createThrottle({ now: time.now, maxKeys: 100 });
    const check = [{ rule: THREE_PER_SECOND, key: "a" }];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(throttle.admit({ checks: check }), { kind: "admitted" });
      time.advance(100);
    }
    assert.deepEqual(throttle.admit({ checks: check }), { kind: "refused", rule: "three per second", retryAfterMs: 700 });
    assert.deepEqual(throttle.admit({ checks: [{ rule: THREE_PER_SECOND, key: "b" }] }), { kind: "admitted" }, "keys are separate");
    time.advance(700);
    assert.deepEqual(throttle.admit({ checks: check }), { kind: "admitted" }, "the oldest attempt left the window");
  });

  test("a refusal by one check records nothing in the others", () => {
    const time = clock();
    const throttle = createThrottle({ now: time.now, maxKeys: 100 });
    for (let attempt = 0; attempt < 3; attempt += 1) throttle.admit({ checks: [{ rule: THREE_PER_SECOND, key: "full" }] });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      throttle.admit({ checks: [{ rule: THREE_PER_SECOND, key: "full" }, { rule: FIVE_PER_MINUTE, key: "spare" }] });
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(throttle.admit({ checks: [{ rule: FIVE_PER_MINUTE, key: "spare" }] }).kind, "admitted", `attempt ${String(attempt)}`);
    }
  });

  test("memory stays bounded by maxKeys", () => {
    const time = clock();
    const throttle = createThrottle({ now: time.now, maxKeys: 10 });
    for (let key = 0; key < 1000; key += 1) throttle.admit({ checks: [{ rule: FIVE_PER_MINUTE, key: String(key) }] });
    assert.ok(throttle.size() <= 10, String(throttle.size()));
  });
});

function request(remoteAddress: string | undefined, headers: IncomingHttpHeaders): Parameters<typeof clientAddress>[0]["request"] {
  return { socket: { remoteAddress }, headers };
}

describe("client address", () => {
  const rows: readonly Readonly<{ name: string; peer: string | undefined; headers: IncomingHttpHeaders; expected: string; ignored: boolean }>[] = [
    { name: "no proxy headers: the socket", peer: "203.0.113.9", headers: {}, expected: "203.0.113.9", ignored: false },
    { name: "loopback peer with X-Real-IP: the header", peer: "127.0.0.1", headers: { "x-real-ip": "198.51.100.7" }, expected: "198.51.100.7", ignored: false },
    { name: "IPv4-mapped loopback peer is loopback", peer: "::ffff:127.0.0.1", headers: { "x-real-ip": "198.51.100.7" }, expected: "198.51.100.7", ignored: false },
    { name: "IPv6 loopback peer", peer: "::1", headers: { "x-real-ip": "2001:db8::1" }, expected: "2001:db8::1", ignored: false },
    {
      name: "a remote peer's X-Real-IP is ignored",
      peer: "203.0.113.9",
      headers: { "x-real-ip": "198.51.100.7", "x-forwarded-for": "198.51.100.8" },
      expected: "203.0.113.9",
      ignored: true,
    },
    {
      name: "loopback peer without X-Real-IP: the LAST X-Forwarded-For hop, which nginx appended",
      peer: "127.0.0.1",
      headers: { "x-forwarded-for": "10.9.9.9, 198.51.100.7" },
      expected: "198.51.100.7",
      ignored: false,
    },
    { name: "loopback peer with a garbage header: the socket", peer: "127.0.0.1", headers: { "x-real-ip": "not-an-ip" }, expected: "127.0.0.1", ignored: false },
    { name: "an IPv4-mapped client is reported as IPv4", peer: "::ffff:203.0.113.9", headers: {}, expected: "203.0.113.9", ignored: false },
    { name: "no socket address at all", peer: undefined, headers: { "x-real-ip": "198.51.100.7" }, expected: "unknown", ignored: true },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.deepEqual(clientAddress({ request: request(row.peer, row.headers), trustedProxies: LOOPBACK_PROXIES }), {
        address: row.expected,
        ignoredForwardedHeader: row.ignored,
      });
    });
  }

  test("--trusted-proxy adds a subnet, such as the Docker bridge nginx reaches the container through", () => {
    const parsed = parseTrustedProxies({ text: "172.16.0.0/12, 10.0.0.5" });
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const viaBridge = clientAddress({ request: request("172.18.0.1", { "x-real-ip": "198.51.100.7" }), trustedProxies: parsed.proxies });
    assert.equal(viaBridge.address, "198.51.100.7");
    assert.equal(clientAddress({ request: request("10.0.0.5", { "x-real-ip": "198.51.100.8" }), trustedProxies: parsed.proxies }).address, "198.51.100.8");
    assert.equal(clientAddress({ request: request("127.0.0.1", { "x-real-ip": "198.51.100.9" }), trustedProxies: parsed.proxies }).address, "198.51.100.9", "loopback stays trusted");
    assert.equal(clientAddress({ request: request("192.168.1.1", { "x-real-ip": "198.51.100.7" }), trustedProxies: parsed.proxies }).address, "192.168.1.1");
  });

  for (const text of ["not-an-address", "10.0.0.0/33", "10.0.0.0/x", ""]) {
    test(`--trusted-proxy ${JSON.stringify(text)} is refused`, () => {
      assert.equal(parseTrustedProxies({ text }).kind, "error");
    });
  }
});
