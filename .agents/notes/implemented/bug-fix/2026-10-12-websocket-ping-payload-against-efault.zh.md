# Agent Note: 带一字节载荷的心跳 Ping

Status: implemented

[English](2026-10-12-websocket-ping-payload-against-efault.md) | 中文

## Problem

`RemoteStreamMuxServer` 在每个心跳节拍发送存活探测 Ping 并统计错过的 Pong。在 Electron 44 上，这个 Ping 摧毁了承载它的套接字：每个心跳节拍都杀掉 mux 套接字，而每次重连都从归零的错过心跳计数重新开始，死对端因此永远不会被发现。

无载荷 Ping 被 `ws` 编码为两段帧——两字节头加一个空缓冲——并以 `cork()`/`uncork()` 写出，于是这次写成为两元素 `writev`，第二个 iovec 长度为 0。Electron 的沙箱 V8 为零长 `ArrayBuffer` 给出的后备存储被内核拒绝，写操作以 `EFAULT` 失败。

## Decision

`HEARTBEAT_PING_PAYLOAD` 为 `Buffer.from([0])`，心跳改为调用 `socket.ping(HEARTBEAT_PING_PAYLOAD)`。

一个字节使两个 iovec 都非空。它在协议上仍是合法的 Ping 载荷：RFC 6455 §5.5.2 允许携带应用数据，上限 125 字节。对端会在 Pong 中原样回送，而本服务忽略之——`on('pong')` 只重置错过心跳计数。

## Alternatives considered

**改发 Pong 而不是 Ping。** 存活机制依赖对端的 Pong 回复；Pong 不索取任何回复，错过心跳计数永不推进，死对端便永不被发现。

**提高 `MAX_MISSED_HEARTBEATS`。** 套接字是被写失败摧毁的，不是被计数摧毁的，容忍更多次错过没有意义。

**依赖 TCP keepalive。** 它在操作系统层面、按操作系统的节奏发现死对端，且无法穿透会终止连接的代理。mux 需要一个应用层存活信号，并能在其失效时采取行动。

**给 `ws` 打补丁，对空载荷跳过 `cork()`。** 写路径是 `ws` 对每一帧的做法；为一个 Electron 版本的一个 V8 缺陷去改它，会把规避措施放在本服务的读者找不到的地方。

## Consequences

现在每次心跳双向各携带一个字节，这是协议允许的量，对端除了看到载荷本身之外无可观测的变化。

该载荷是针对一组特定搭配的规避——Electron 44 的沙箱 V8 与 `ws` 对空帧的 corked 写。日后若某个 Electron 能正确为零长缓冲提供后备存储，该载荷将变得多余而非错误：带一字节的 Ping 依其自身规格就是合法的。

`packages/api/gateway/tests/gateway-stream.host.spec.ts` 断言了该载荷，因此若将来有人改回无载荷 Ping，测试会失败，而不会在 Electron 下静默重现套接字抖动。
