import http from "node:http";
import { URL } from "node:url";

import { CodexAppServerClient, defaultCodexCwd } from "./codex-client.js";
import { CodexProgressService } from "./progress.js";
import {
  CodexMcpApplication,
  bearerTokenMatches,
  createSessionId,
  parseJsonRpcBody,
} from "./mcp-server.js";

const VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;

function parseArgs(argv) {
  const options = {
    host: process.env.CODEX_BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.CODEX_BRIDGE_PORT || 8787),
    token: process.env.CODEX_BRIDGE_TOKEN || "",
    corsOrigin: process.env.CODEX_BRIDGE_CORS_ORIGIN || "",
    codexBin: process.env.CODEX_BIN || null,
    cwd: defaultCodexCwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--token" && next) {
      options.token = next;
      index += 1;
    } else if (arg === "--codex-bin" && next) {
      options.codexBin = next;
      index += 1;
    } else if (arg === "--cwd" && next) {
      options.cwd = next;
      index += 1;
    } else if (arg === "--version") {
      options.version = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

function isLoopbackHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function helpText() {
  return `Codex Mobile Bridge ${VERSION}

Usage:
  npm start -- [--host 127.0.0.1] [--port 8787] [--token TOKEN]
             [--cwd PROJECT] [--codex-bin PATH]

Environment:
  CODEX_BRIDGE_TOKEN   Bearer token required for HTTP requests.
  CODEX_BRIDGE_HOST    Listen host (default 127.0.0.1).
  CODEX_BRIDGE_PORT    Listen port (default 8787).
  CODEX_BRIDGE_CWD     Default project directory for new chats.
  CODEX_BRIDGE_CORS_ORIGIN  Optional browser origin allowed to call the bridge.
  CODEX_BIN             Codex executable path.
`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error("Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function setCors(response, corsOrigin) {
  if (!corsOrigin) {
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", corsOrigin);
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Vary", "Origin");
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.headersSent) {
    return;
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function sendSseMessage(response, value) {
  response.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}

export function createBridgeServer({
  host = "127.0.0.1",
  port = 8787,
  token = "",
  corsOrigin = process.env.CODEX_BRIDGE_CORS_ORIGIN || "",
  codexBin = null,
  cwd = defaultCodexCwd(),
  service = null,
  client = null,
} = {}) {
  if (!isLoopbackHost(host) && !token) {
    throw new Error("Refusing to listen on a non-loopback host without CODEX_BRIDGE_TOKEN or --token");
  }

  const codexClient = client || new CodexAppServerClient({ codexBin, cwd });
  const ownsClient = !client;
  const progressService = service || new CodexProgressService(codexClient, { defaultCwd: cwd });
  const application = new CodexMcpApplication({ service: progressService, version: VERSION });
  const sessions = new Map();
  const sseConnections = new Map();

  const authenticate = (request) => bearerTokenMatches(request, token);
  const originAllowed = (request) => {
    const origin = request.headers.origin;
    return !origin || corsOrigin === "*" || origin === corsOrigin;
  };

  const rememberSession = (sessionId) => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (!sseConnections.has(id) && now - session.lastSeen > 24 * 60 * 60 * 1_000) {
        sessions.delete(id);
      }
    }
    while (sessions.size >= 1_000) {
      const oldest = [...sessions.keys()].find((id) => !sseConnections.has(id));
      if (!oldest) {
        break;
      }
      sessions.delete(oldest);
    }
    sessions.set(sessionId, { createdAt: now, lastSeen: now });
  };

  const handleInitialize = (message, response) => {
    const sessionId = createSessionId();
    rememberSession(sessionId);
    return application.dispatch(message).then((result) => {
      if (result) {
        sendJson(response, 200, result, { "Mcp-Session-Id": sessionId });
      } else {
        sendJson(response, 202, {}, { "Mcp-Session-Id": sessionId });
      }
    });
  };

  const handleSse = (request, response) => {
    const sessionId = createSessionId();
    rememberSession(sessionId);
    setCors(response, corsOrigin);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Mcp-Session-Id": sessionId,
    });
    const endpoint = `/messages?sessionId=${encodeURIComponent(sessionId)}`;
    response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
    sseConnections.set(sessionId, { response, keepAlive });
    request.on("close", () => {
      clearInterval(keepAlive);
      sseConnections.delete(sessionId);
      sessions.delete(sessionId);
    });
  };

  const server = http.createServer(async (request, response) => {
    if (!originAllowed(request)) {
      sendJson(response, 403, { error: "Origin not allowed" });
      return;
    }
    setCors(response, corsOrigin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (!authenticate(request)) {
      sendJson(response, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "codex-mobile-bridge", version: VERSION });
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      sendJson(response, 200, {
        service: "codex-mobile-bridge",
        version: VERSION,
        mcp_endpoint: "/mcp",
        legacy_sse_endpoint: "/sse",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/sse") {
      handleSse(request, response);
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/mcp") {
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId) {
        sessions.delete(sessionId);
      }
      response.writeHead(204);
      response.end();
      return;
    }

    const isMcpPost = request.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/messages" || url.pathname === "/messages/");
    if (!isMcpPost) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { error: "Content-Type must be application/json" });
      return;
    }

    let messages;
    try {
      messages = parseJsonRpcBody(await readBody(request));
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }

    const headerSessionId = request.headers["mcp-session-id"];
    const querySessionId = url.searchParams.get("sessionId");
    const sessionId = headerSessionId || querySessionId;
    if (sessionId && !sessions.has(sessionId)) {
      sendJson(response, 404, { error: "Unknown MCP session" });
      return;
    }
    if (sessionId) {
      sessions.get(sessionId).lastSeen = Date.now();
    }

    if (messages.length === 1 && messages[0]?.method === "initialize") {
      await handleInitialize(messages[0], response);
      return;
    }

    const results = [];
    for (const message of messages) {
      const result = await application.dispatch(message);
      if (result) {
        results.push(result);
      }
    }
    if (!results.length) {
      response.writeHead(202);
      response.end();
      return;
    }

    // Legacy SSE clients send requests to /messages and receive the result on
    // the long-lived /sse connection rather than in the POST response.
    const legacyConnection = sessionId ? sseConnections.get(sessionId) : null;
    if (legacyConnection && (url.pathname === "/messages" || url.pathname === "/messages/")) {
      for (const result of results) {
        sendSseMessage(legacyConnection.response, result);
      }
      response.writeHead(202);
      response.end();
      return;
    }

    const wantsSse = String(request.headers.accept || "").includes("text/event-stream");
    if (wantsSse) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      });
      for (const result of results) {
        sendSseMessage(response, result);
      }
      response.end();
      return;
    }

    const payload = results.length === 1 ? results[0] : results;
    sendJson(response, 200, payload, sessionId ? { "Mcp-Session-Id": sessionId } : {});
  });

  return {
    server,
    client: codexClient,
    sessions,
    async close() {
      for (const connection of sseConnections.values()) {
        clearInterval(connection.keepAlive);
        connection.response.end();
      }
      sseConnections.clear();
      sessions.clear();
      if (ownsClient) {
        await codexClient.stop();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve(server.address());
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
  };
}

export async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (options.help) {
    console.log(helpText());
    return;
  }

  const bridge = createBridgeServer(options);
  const address = await bridge.listen();
  const displayHost = typeof address === "object" && address ? address.address : options.host;
  console.log(`codex-mobile-bridge listening on http://${displayHost}:${options.port}/mcp`);
  console.log(`authentication: ${options.token ? "Bearer token enabled" : "loopback-only (no token)"}`);

  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export { isLoopbackHost, parseArgs };
