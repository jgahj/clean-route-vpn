import test from "node:test";
import assert from "node:assert/strict";

import { CodexProgressService } from "../src/progress.js";

test("getProgress merges live turn state with persisted history", async () => {
  const client = {
    async request(method) {
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            cwd: "C:\\demo",
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        };
      }
      if (method === "thread/turns/list") {
        return { data: [] };
      }
      throw new Error(method);
    },
    getTurnStatesForThread() {
      return [{
        threadId: "thread-1",
        turnId: "turn-live",
        status: "in_progress",
        reply: "正在处理",
        approvalRequests: [],
      }];
    },
  };
  const service = new CodexProgressService(client);
  const progress = await service.getProgress("thread-1");
  assert.equal(progress.active_turn.id, "turn-live");
  assert.equal(progress.active_turn.live_reply, "正在处理");
});

test("chat starts a new read-only thread by default", async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-new" }, cwd: params.cwd };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-new" } };
      }
      throw new Error(method);
    },
    async waitForTurn() {
      return { status: "completed", reply: "OK", timedOut: false, approvalRequests: [] };
    },
  };
  const service = new CodexProgressService(client, { defaultCwd: "C:\\demo" });
  const result = await service.chat({ message: "hello" });
  assert.equal(result.reply, "OK");
  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.sandbox, "read-only");
  assert.equal(calls[1].method, "turn/start");
  assert.equal(calls[1].params.sandboxPolicy, undefined);
});
