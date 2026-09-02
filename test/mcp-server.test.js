import test from "node:test";
import assert from "node:assert/strict";

import { createBridgeServer } from "../src/server.js";

function fakeService() {
  return {
    async listProjects() {
      return { projects: [{ cwd: "C:\\demo", task_count: 1 }], count: 1 };
    },
    async listTasks() {
      return { tasks: [{ id: "thread-1", status: "idle" }], count: 1, next_cursor: null };
    },
    async getProgress(threadId) {
      return { thread: { id: threadId }, turns: [] };
    },
    async chat(input) {
      return { thread_id: input.threadId || "thread-new", turn_id: "turn-1", status: "completed", reply: "OK", timed_out: false };
    },
  };
}

async function request(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("MCP initialize and tools/list work with a session", async () => {
  const bridge = createBridgeServer({ port: 0, service: fakeService() });
  const address = await bridge.listen();
  try {
    const initialized = await request(address.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.body.result.protocolVersion, "2025-03-26");
    const sessionId = initialized.response.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const listed = await request(address.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, { "mcp-session-id": sessionId });
    assert.equal(listed.response.status, 200);
    assert.deepEqual(
      listed.body.result.tools.map((tool) => tool.name),
      ["codex_list_projects", "codex_list_tasks", "codex_get_progress", "codex_chat"],
    );
  } finally {
    await bridge.close();
  }
});

test("non-loopback listeners require a token", () => {
  assert.throws(() => createBridgeServer({ host: "0.0.0.0", service: fakeService() }), /token/i);
});

test("tool failures use an MCP tool error instead of an HTTP error", async () => {
  const service = { ...fakeService(), async listTasks() { throw new Error("test failure"); } };
  const bridge = createBridgeServer({ port: 0, service });
  const address = await bridge.listen();
  try {
    const result = await request(address.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "codex_list_tasks", arguments: {} },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /test failure/);
  } finally {
    await bridge.close();
  }
});

test("Bearer token protects the MCP endpoint", async () => {
  const bridge = createBridgeServer({ port: 0, token: "secret-token", service: fakeService() });
  const address = await bridge.listen();
  try {
    const denied = await request(address.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    assert.equal(denied.response.status, 401);

    const allowed = await request(address.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, { authorization: "Bearer secret-token" });
    assert.equal(allowed.response.status, 200);
  } finally {
    await bridge.close();
  }
});

test("legacy SSE transport returns tool results on the event stream", async () => {
  const bridge = createBridgeServer({ port: 0, service: fakeService() });
  const address = await bridge.listen();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/sse`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const sessionId = response.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const endpointEvent = decoder.decode((await reader.read()).value);
    assert.match(endpointEvent, /event: endpoint/);

    const posted = await fetch(`http://127.0.0.1:${address.port}/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    assert.equal(posted.status, 202);
    const resultEvent = decoder.decode((await reader.read()).value);
    assert.match(resultEvent, /codex_list_projects/);
    await reader.cancel();
  } finally {
    controller.abort();
    await bridge.close();
  }
});
