# Agent Note: A one-byte heartbeat Ping payload

Status: implemented

English | [中文](2026-10-12-websocket-ping-payload-against-efault.zh.md)

## Problem

`RemoteStreamMuxServer` sends a liveness Ping on every heartbeat tick and counts missed Pongs. On Electron 44 the Ping destroyed the socket that carried it: every heartbeat tick killed the mux socket, and each reconnect started a fresh, zeroed missed-heartbeat counter, so a dead peer was never detected.

A payload-less Ping is encoded by `ws` as a two-part frame — a two-byte header and an empty buffer — and written with `cork()`/`uncork()`, which makes the write a two-element `writev` whose second iovec has length 0. Electron's sandboxed V8 hands out a backing store for a zero-length `ArrayBuffer` that the kernel rejects, and the write fails with `EFAULT`.

## Decision

`HEARTBEAT_PING_PAYLOAD` is `Buffer.from([0])`, and the heartbeat calls `socket.ping(HEARTBEAT_PING_PAYLOAD)`.

One byte keeps both iovecs non-empty. It remains a protocol-legal Ping payload: RFC 6455 §5.5.2 allows application data, and caps it at 125 bytes. The peer echoes it in its Pong, which this server ignores — `on('pong')` only resets the missed-heartbeat counter.

## Alternatives considered

**Send a Pong instead of a Ping.** The liveness mechanism is the peer's Pong reply; a Pong solicits none, and the missed-heartbeat counter would never advance, so a dead peer would never be detected.

**Raise `MAX_MISSED_HEARTBEATS`.** The socket is destroyed by the write failure, not by the counter, so tolerating more misses changes nothing.

**Rely on TCP keepalive.** It detects a dead peer at the OS level, on the OS's schedule, and it does not survive a proxy that terminates the connection. The mux needs an application-level liveness signal whose failure it can act on.

**Patch `ws` to skip `cork()` for empty payloads.** The write path is what `ws` does for every frame; changing it to accommodate one V8 defect in one Electron version would put the workaround where no reader of this server would find it.

## Consequences

Every heartbeat now carries one byte in each direction, which is a protocol-legal amount and not a change any peer can observe beyond its payload.

The payload is a workaround for a specific pairing — Electron 44's sandboxed V8 and `ws`'s corked empty-frame write. A later Electron that backs zero-length buffers correctly makes the payload unnecessary, not wrong: a one-byte Ping is valid on its own terms.

`packages/api/gateway/tests/gateway-stream.host.spec.ts` asserts the payload, so a future change that reverts to a payload-less Ping fails the test rather than silently reintroducing socket churn under Electron.
