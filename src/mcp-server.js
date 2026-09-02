import { randomUUID, timingSafeEqual } from "node:crypto";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const TOOL_DEFINITIONS = [
  {
    name: "codex_list_projects",
    description: "列出本机 Codex 最近使用的项目目录，并汇总任务数量和活动状态。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        include_archived: { type: "boolean", default: false },
        search: { type: "string", maxLength: 200 },
      },
    },
  },
  {
    name: "codex_list_tasks",
    description: "列出本机 Codex 任务，可按项目目录或标题筛选。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        include_archived: { type: "boolean", default: false },
        cwd: { type: "string", description: "项目绝对路径" },
        search: { type: "string", maxLength: 200 },
      },
    },
  },
  {
    name: "codex_get_progress",
    description: "读取指定 Codex 任务的当前状态、最近回合、助手回复、命令状态和文件变更摘要。不会返回隐藏思维链。",
    inputSchema: {
      type: "object",
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string", minLength: 1 },
        turn_limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
    },
  },
  {
    name: "codex_chat",
    description: "向已有 Codex 任务发送消息并等待回复；不提供 thread_id 时会在 cwd 创建一个新任务。超时后返回 turn_id，可用 codex_get_progress 继续查看。",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        thread_id: { type: "string", description: "已有 Codex 任务 ID" },
        cwd: { type: "string", description: "创建新任务时使用的项目绝对路径" },
        message: { type: "string", minLength: 1, maxLength: 20000 },
        wait_ms: { type: "integer", minimum: 1000, maximum: 300000, default: 90000 },
        approval_policy: {
          type: "string",
          enum: ["untrusted", "on-request", "never"],
          description: "仅新建任务时生效。never 会允许 Codex 无人值守执行操作，请谨慎使用。",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "仅新建任务时生效；默认为 read-only。",
        },
        model: { type: "string", maxLength: 100, description: "仅新建任务时生效。" },
      },
    },
  },
];

function chooseProtocolVersion(requested) {
  return MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: "2.0", id, error };
}

function isNotification(message) {
  return message && typeof message === "object" && !Object.prototype.hasOwnProperty.call(message, "id");
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolText(name, value) {
  if (name === "codex_chat" && value?.reply) {
    const status = value.timed_out ? "in_progress" : value.status;
    return `${value.reply}\n\n[Codex ${status}; thread_id=${value.thread_id}; turn_id=${value.turn_id}]`;
  }
  return safeJson(value);
}

export class CodexMcpApplication {
  constructor({ service, version = "0.1.0" }) {
    this.service = service;
    this.version = version;
  }

  async dispatch(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || !message.method) {
      return rpcError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
    }

    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      return null;
    }
    const notification = isNotification(message);
    if (message.method === "ping") {
      return notification ? null : rpcResult(message.id, {});
    }
    if (message.method === "initialize") {
      const params = message.params || {};
      return rpcResult(message.id, {
        protocolVersion: chooseProtocolVersion(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "codex-mobile-bridge",
          version: this.version,
        },
        instructions: "Use codex_list_projects/codex_list_tasks to find a task, then codex_get_progress or codex_chat.",
      });
    }
    if (message.method === "tools/list") {
      return notification ? null : rpcResult(message.id, { tools: TOOL_DEFINITIONS });
    }
    if (message.method !== "tools/call") {
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
    }

    const params = message.params || {};
    const name = params.name;
    const args = params.arguments || {};
    if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
      return rpcError(message.id, -32602, `Unknown tool: ${name}`);
    }

    try {
      let value;
      switch (name) {
        case "codex_list_projects":
          value = await this.service.listProjects({
            limit: args.limit,
            includeArchived: args.include_archived,
            search: args.search,
          });
          break;
        case "codex_list_tasks":
          value = await this.service.listTasks({
            limit: args.limit,
            includeArchived: args.include_archived,
            cwd: args.cwd,
            search: args.search,
          });
          break;
        case "codex_get_progress":
          value = await this.service.getProgress(requireString(args.thread_id, "thread_id"), { turnLimit: args.turn_limit });
          break;
        case "codex_chat":
          value = await this.service.chat({
            threadId: args.thread_id,
            cwd: args.cwd,
            message: requireString(args.message, "message"),
            waitMs: args.wait_ms,
            approvalPolicy: args.approval_policy,
            sandbox: args.sandbox,
            model: args.model,
          });
          break;
        default:
          throw new Error(`Unhandled tool: ${name}`);
      }
      return notification ? null : rpcResult(message.id, {
        content: [{ type: "text", text: toolText(name, value) }],
        structuredContent: value,
        isError: false,
      });
    } catch (error) {
      const text = error?.message || String(error);
      return notification ? null : rpcResult(message.id, {
        content: [{ type: "text", text: `Codex bridge error: ${text}` }],
        structuredContent: { error: text },
        isError: true,
      });
    }
  }
}

export function createSessionId() {
  return randomUUID();
}

export function bearerTokenMatches(request, expectedToken) {
  if (!expectedToken) {
    return true;
  }
  const header = request.headers.authorization || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  const actual = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseJsonRpcBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
  if (Array.isArray(parsed)) {
    if (!parsed.length) {
      throw new Error("JSON-RPC batch cannot be empty");
    }
    return parsed;
  }
  return [parsed];
}
