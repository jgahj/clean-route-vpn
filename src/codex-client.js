import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDERR_LENGTH = 32_000;

export class CodexAppServerError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    this.data = data;
  }
}

function isWindows() {
  return process.platform === "win32";
}

function looksLikeWindowsScript(command) {
  return /\.(cmd|bat|ps1)$/i.test(command);
}

function localCodexExecutables() {
  if (!isWindows() || !process.env.LOCALAPPDATA) {
    return [];
  }

  const root = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  if (!existsSync(root)) {
    return [];
  }

  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name, "codex.exe");
    if (existsSync(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return right.localeCompare(left);
    }
  });
}

function pathCandidatesFromWhere() {
  if (!isWindows()) {
    return [];
  }

  try {
    const output = execFileSync("where.exe", ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value && !looksLikeWindowsScript(value) && /\.exe$/i.test(value));
  } catch {
    return [];
  }
}

/**
 * Resolve a native Codex executable when possible. The npm shim is retained
 * as a fallback for installations that do not expose the native binary.
 */
export function resolveCodexExecutable(explicitCommand = null) {
  const configured = explicitCommand || process.env.CODEX_BIN;
  if (configured) {
    return {
      command: configured,
      shell: isWindows() && (looksLikeWindowsScript(configured) || !/\.exe$/i.test(configured)),
    };
  }

  const candidates = [...localCodexExecutables(), ...pathCandidatesFromWhere()];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: candidate, shell: false };
    }
  }

  return {
    command: isWindows() ? "codex.cmd" : "codex",
    shell: isWindows(),
  };
}

function jsonRpcIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function textOutputItem(text) {
  return { type: "inputText", text };
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    codexBin = null,
    codexArgs = [],
    cwd = process.cwd(),
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    env = process.env,
  } = {}) {
    super();
    this.codexBin = codexBin;
    this.codexArgs = codexArgs;
    this.cwd = cwd;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.env = { ...env };

    this.child = null;
    this.startPromise = null;
    this.ready = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.turnStates = new Map();
  }

  async ensureStarted() {
    if (this.ready && this.child && !this.child.killed) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.#start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start() {
    const resolved = resolveCodexExecutable(this.codexBin);
    const args = ["app-server", "--listen", "stdio://", ...this.codexArgs];
    const child = spawn(resolved.command, args, {
      cwd: this.cwd,
      env: this.env,
      shell: resolved.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child = child;
    this.ready = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_STDERR_LENGTH);
      this.emit("stderr", chunk);
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.ready = false;
        this.child = null;
        this.#failPending(error);
        this.emit("processError", error);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      const message = `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      const error = new CodexAppServerError(message, {
        data: this.stderrBuffer || null,
      });
      this.ready = false;
      this.child = null;
      this.#failPending(error);
      this.emit("exit", { code, signal, message });
    });

    try {
      await this.#withTimeout(
        this.#requestRaw("initialize", {
          clientInfo: {
            name: "codex-mobile-bridge",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        }, this.startupTimeoutMs),
        this.startupTimeoutMs,
        "Timed out while starting Codex app-server",
      );
      this.#write({ method: "initialized" });
      this.ready = true;
    } catch (error) {
      this.ready = false;
      if (this.child === child && !child.killed) {
        child.kill();
      }
      throw this.#decorateError(error);
    }
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    await this.ensureStarted();
    return this.#requestRaw(method, params, timeoutMs);
  }

  async #requestRaw(method, params, timeoutMs) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new CodexAppServerError("Codex app-server is not running");
    }

    const id = this.nextRequestId++;
    const key = jsonRpcIdKey(id);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new CodexAppServerError(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer, method });
    });

    try {
      this.#write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(error);
      }
    }

    return promise;
  }

  #write(message) {
    if (!this.child?.stdin?.writable) {
      throw new CodexAppServerError("Codex app-server stdin is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.emit("stdout", trimmed);
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (hasOwn(message, "id") && hasOwn(message, "method")) {
      void this.#handleServerRequest(message);
      return;
    }

    if (hasOwn(message, "id")) {
      const key = jsonRpcIdKey(message.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);
      if (message.error) {
        pending.reject(new CodexAppServerError(message.error.message || "Codex request failed", {
          code: message.error.code,
          data: message.error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.#recordNotification(message);
      this.emit(message.method, message.params ?? {});
      this.emit("notification", message);
    }
  }

  #recordNotification(message) {
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    if (!turnId) {
      return;
    }

    const state = this.turnStates.get(turnId) || {
      threadId: params.threadId || null,
      turnId,
      status: "in_progress",
      reply: "",
      items: [],
      approvalRequests: [],
      completed: null,
    };
    if (params.threadId) {
      state.threadId = params.threadId;
    }

    switch (message.method) {
      case "turn/started":
        state.status = "in_progress";
        state.turn = params.turn || state.turn;
        break;
      case "item/agentMessage/delta":
        state.reply = `${state.reply}${params.delta || ""}`;
        break;
      case "item/completed":
        if (params.item) {
          state.items.push(params.item);
          if (params.item.type === "agentMessage" && params.item.text) {
            state.reply = params.item.text;
          }
        }
        break;
      case "turn/completed":
        state.status = params.turn?.status || "completed";
        state.turn = params.turn || state.turn;
        state.completed = params.turn || null;
        if (params.turn?.items) {
          state.items = params.turn.items;
          const messages = params.turn.items.filter((item) => item.type === "agentMessage" && item.text);
          if (messages.length) {
            state.reply = messages[messages.length - 1].text;
          }
        }
        this.#pruneTurnStates();
        break;
      default:
        break;
    }
    this.turnStates.set(turnId, state);
  }

  async #handleServerRequest(message) {
    this.emit("serverRequest", message);
    let result;
    switch (message.method) {
      case "currentTime/read":
        result = { currentTimeAt: Math.floor(Date.now() / 1000) };
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
      case "execCommandApproval":
        // A phone client cannot safely approve an unattended local action.
        result = { decision: message.method === "applyPatchApproval" || message.method === "execCommandApproval" ? "abort" : "decline" };
        {
          const turnId = message.params?.turnId;
          if (turnId) {
            const state = this.turnStates.get(turnId) || {
              threadId: message.params?.threadId || null,
              turnId,
              status: "in_progress",
              reply: "",
              items: [],
              approvalRequests: [],
              completed: null,
            };
            state.approvalRequests = state.approvalRequests || [];
            state.approvalRequests.push({
              method: message.method,
              reason: message.params?.reason || null,
              command: message.params?.command || null,
              decision: result.decision,
            });
            this.turnStates.set(turnId, state);
          }
        }
        this.emit("approvalRequired", message.params || {});
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn" };
        this.emit("approvalRequired", message.params || {});
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      case "mcpServer/elicitation/request":
        result = { action: "decline" };
        break;
      case "item/tool/call":
        result = {
          success: false,
          contentItems: [textOutputItem("The mobile bridge does not proxy dynamic tool calls.")],
        };
        break;
      default:
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported Codex server request: ${message.method}` },
        });
        return;
    }
    try {
      this.#write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.emit("processError", error);
    }
  }

  async waitForTurn(threadId, turnId, timeoutMs = this.requestTimeoutMs) {
    const existing = this.turnStates.get(turnId);
    if (existing?.completed || (existing && existing.status !== "in_progress")) {
      return this.#publicTurnState(existing);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.off("turn/completed", onCompleted);
        this.off("exit", onExit);
        resolve(value);
      };
      const onCompleted = (params) => {
        if (params.threadId === threadId && params.turn?.id === turnId) {
          finish(this.#publicTurnState(this.turnStates.get(turnId)));
        }
      };
      const onExit = () => finish(this.#publicTurnState(this.turnStates.get(turnId)));
      const timer = setTimeout(() => {
        finish({
          ...this.#publicTurnState(this.turnStates.get(turnId)),
          status: "in_progress",
          timedOut: true,
        });
      }, timeoutMs);
      this.on("turn/completed", onCompleted);
      this.on("exit", onExit);

      const current = this.turnStates.get(turnId);
      if (current?.completed || (current && current.status !== "in_progress")) {
        finish(this.#publicTurnState(current));
      }
    });
  }

  getTurnState(turnId) {
    return this.#publicTurnState(this.turnStates.get(turnId));
  }

  getTurnStatesForThread(threadId) {
    return [...this.turnStates.values()]
      .filter((state) => state.threadId === threadId)
      .map((state) => this.#publicTurnState(state));
  }

  #pruneTurnStates() {
    const maximum = 500;
    while (this.turnStates.size > maximum) {
      const oldest = this.turnStates.keys().next().value;
      this.turnStates.delete(oldest);
    }
  }

  #publicTurnState(state) {
    if (!state) {
      return { status: "unknown", reply: "", items: [] };
    }
    return {
      threadId: state.threadId,
      turnId: state.turnId,
      status: state.status || "unknown",
      reply: state.reply || "",
      items: state.items || [],
      approvalRequests: state.approvalRequests || [],
      turn: state.turn || state.completed || null,
      timedOut: false,
    };
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#decorateError(error));
    }
    this.pending.clear();
  }

  #decorateError(error) {
    if (error instanceof CodexAppServerError) {
      return error;
    }
    return new CodexAppServerError(error?.message || String(error));
  }

  async #withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new CodexAppServerError(message)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop() {
    const child = this.child;
    this.ready = false;
    this.child = null;
    if (!child || child.killed) {
      return;
    }
    this.#failPending(new CodexAppServerError("Codex app-server stopped"));
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed its input stream.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function defaultCodexCwd() {
  return process.env.CODEX_BRIDGE_CWD || process.cwd() || os.homedir();
}
