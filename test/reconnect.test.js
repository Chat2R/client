import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Chat2rClient } from "../src/client.js";
import { makeMessage, MSG_TYPES, parseMessage } from "../src/protocol.js";

function quietUi() {
  const logs = [];
  return {
    logs,
    banner() {},
    log(message, type = "info") {
      logs.push({ message: String(message), type });
    },
    section() {},
    close() {}
  };
}

function fakeExecutor() {
  return {
    roots: [process.cwd()],
    async shutdown() {}
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRelay(port) {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = parseMessage(raw);
      if (message?.type !== MSG_TYPES.HELLO) return;
      socket.send(makeMessage(MSG_TYPES.DEVICE_READY, { name: "TestMachine" }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function createClient(port, ui = quietUi()) {
  return new Chat2rClient({
    server: `http://127.0.0.1:${port}`,
    unattended: true,
    noOpen: true,
    ui,
    executor: fakeExecutor(),
    random: () => 0.5,
    reconnectMinMs: 100,
    reconnectMaxMs: 200,
    connectTimeoutMs: 1000,
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 2500
  });
}

test("unattended client survives starting before the relay", async () => {
  const port = await reservePort();
  const ui = quietUi();
  const client = createClient(port, ui);

  await client.start();
  await waitFor(() => ui.logs.some((entry) => entry.message.includes("Reconnecting in")));

  const relay = await startRelay(port);
  try {
    await waitFor(() => client.ready === true);
    assert.equal(client.stopped, false);
    assert.equal(client.ready, true);
  } finally {
    client.stop();
    await relay.close();
  }
});

test("unattended client reconnects after a relay reboot", async () => {
  const port = await reservePort();
  let relay = await startRelay(port);
  const client = createClient(port);

  try {
    await client.start();
    await waitFor(() => client.ready === true);

    await relay.close();
    await waitFor(() => client.ready === false);

    relay = await startRelay(port);
    await waitFor(() => client.ready === true);

    assert.equal(client.stopped, false);
    assert.equal(client.ready, true);
  } finally {
    client.stop();
    await relay.close().catch(() => {});
  }
});

test("action completion during a relay outage does not crash the client", async () => {
  const client = createClient(await reservePort());
  client.executor.getSystemInfo = () => ({ ok: true });

  await assert.doesNotReject(() => client.handleAction({
    actionId: "action-1",
    tool: "get_system_info",
    args: {},
    needsApproval: false
  }));

  client.stop();
});
