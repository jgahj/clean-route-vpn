import path from "node:path";

const DEFAULT_LIMIT = 50;
const MAX_PREVIEW_LENGTH = 280;
const MAX_OUTPUT_LENGTH = 1_500;
const MAX_ITEMS_PER_KIND = 20;

function truncate(value, maxLength = MAX_OUTPUT_LENGTH) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function statusType(status) {
  if (typeof status === "string") {
    return status;
  }
  return status?.type || "unknown";
}

function statusFlags(status) {
  return Array.isArray(status?.activeFlags) ? status.activeFlags : [];
}

function isoTime(seconds) {
  if (seconds === null || seconds === undefined) {
    return null;
  }
  const value = Number(seconds);
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function textFromUserItem(item) {
  return (item?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("");
}

function normalizeSource(source) {
  if (typeof source === "string") {
    return source;
  }
  if (source?.custom) {
    return source.custom;
  }
  if (source?.subAgent) {
    return `subAgent:${typeof source.subAgent === "string" ? source.subAgent : "unknown"}`;
  }
  return "unknown";
}

function normalizeThread(thread) {
  const status = statusType(thread?.status);
  return {
    id: thread?.id || null,
    title: thread?.name || null,
    preview: truncate(thread?.preview || "", MAX_PREVIEW_LENGTH),
    cwd: thread?.cwd || null,
    source: normalizeSource(thread?.source),
    status,
    active_flags: statusFlags(thread?.status),
    can_accept_direct_input: thread?.canAcceptDirectInput ?? null,
    is_pinned: Boolean(thread?.isPinned),
    archived: Boolean(thread?.archived),
    created_at: isoTime(thread?.createdAt),
    updated_at: isoTime(thread?.updatedAt),
    model_provider: thread?.modelProvider || null,
    history_mode: thread?.historyMode || "legacy",
  };
}

function normalizeCommand(item) {
  return {
    command: truncate(item?.command || "", MAX_OUTPUT_LENGTH),
    status: item?.status || "unknown",
    exit_code: item?.exitCode ?? null,
    output: truncate(item?.aggregatedOutput, MAX_OUTPUT_LENGTH),
    duration_ms: item?.durationMs ?? null,
  };
}

function normalizeFileChange(item) {
  return {
    status: item?.status || "unknown",
    files: (item?.changes || [])
      .map((change) => change?.path)
      .filter(Boolean),
  };
}

export function normalizeTurn(turn) {
  const agentMessages = [];
  const userMessages = [];
  const commands = [];
  const fileChanges = [];
  for (const item of turn?.items || []) {
    if (item?.type === "agentMessage" && item.text) {
      agentMessages.push({ text: truncate(item.text, MAX_OUTPUT_LENGTH), phase: item.phase || null });
    } else if (item?.type === "userMessage") {
      const text = textFromUserItem(item);
      if (text) {
        userMessages.push(truncate(text, MAX_OUTPUT_LENGTH));
      }
    } else if (item?.type === "commandExecution") {
      commands.push(normalizeCommand(item));
    } else if (item?.type === "fileChange") {
      fileChanges.push(normalizeFileChange(item));
    }
  }

  return {
    id: turn?.id || null,
    status: turn?.status || "unknown",
    started_at: isoTime(turn?.startedAt),
    completed_at: isoTime(turn?.completedAt),
    duration_ms: turn?.durationMs ?? null,
    error: turn?.error ? {
      message: truncate(turn.error.message, MAX_OUTPUT_LENGTH),
      details: truncate(turn.error.additionalDetails, MAX_OUTPUT_LENGTH),
    } : null,
    user_messages: userMessages.slice(-MAX_ITEMS_PER_KIND),
    assistant_messages: agentMessages.slice(-MAX_ITEMS_PER_KIND),
    commands: commands.slice(-MAX_ITEMS_PER_KIND),
    file_changes: fileChanges.slice(-MAX_ITEMS_PER_KIND),
  };
}

function canonicalCwd(cwd) {
  if (!cwd) {
    return "";
  }
  const normalized = path.normalize(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class CodexProgressService {
  constructor(client, { defaultCwd = process.cwd() } = {}) {
    this.client = client;
    this.defaultCwd = defaultCwd;
  }

  async #fetchTasks({ archived, limit, cwd, search }) {
    const params = {
      archived,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: false,
    };
    if (cwd) {
      params.cwd = cwd;
    }
    if (search) {
      params.searchTerm = search;
    }
    const response = await this.client.request("thread/list", params);
    return (response?.data || []).map((thread) => ({ ...thread, archived }));
  }

  async listTasks({
    limit = DEFAULT_LIMIT,
    includeArchived = false,
    cwd = null,
    search = null,
  } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));
    const active = await this.#fetchTasks({ archived: false, limit: boundedLimit, cwd, search });
    let threads = active;
    if (includeArchived) {
      const archived = await this.#fetchTasks({ archived: true, limit: boundedLimit, cwd, search });
      const byId = new Map([...active, ...archived].map((thread) => [thread.id, thread]));
      threads = [...byId.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    }
    return {
      tasks: threads.slice(0, boundedLimit).map(normalizeThread),
      count: Math.min(threads.length, boundedLimit),
      next_cursor: null,
    };
  }

  async listProjects({ limit = 50, includeArchived = false, search = null } = {}) {
    const tasksResult = await this.listTasks({ limit: 200, includeArchived, search });
    const projects = new Map();
    for (const task of tasksResult.tasks) {
      if (!task.cwd) {
        continue;
      }
      const key = canonicalCwd(task.cwd);
      const project = projects.get(key) || {
        cwd: task.cwd,
        name: path.basename(task.cwd) || task.cwd,
        task_count: 0,
        active_task_count: 0,
        idle_task_count: 0,
        not_loaded_task_count: 0,
        error_task_count: 0,
        latest_updated_at: null,
        latest_task: null,
      };
      project.task_count += 1;
      if (task.status === "active") {
        project.active_task_count += 1;
      } else if (task.status === "idle") {
        project.idle_task_count += 1;
      } else if (task.status === "notLoaded") {
        project.not_loaded_task_count += 1;
      } else if (task.status === "systemError") {
        project.error_task_count += 1;
      }
      if (!project.latest_updated_at || (task.updated_at && task.updated_at > project.latest_updated_at)) {
        project.latest_updated_at = task.updated_at;
        project.latest_task = {
          id: task.id,
          title: task.title,
          status: task.status,
          updated_at: task.updated_at,
        };
      }
      projects.set(key, project);
    }

    const result = [...projects.values()]
      .sort((left, right) => (right.latest_updated_at || "").localeCompare(left.latest_updated_at || ""))
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
    return { projects: result, count: result.length };
  }

  async getProgress(threadId, { turnLimit = 5 } = {}) {
    if (!threadId || typeof threadId !== "string") {
      throw new Error("thread_id is required");
    }
    const metadata = await this.client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    const thread = metadata?.thread || metadata;
    let turns = [];
    try {
      const response = await this.client.request("thread/turns/list", {
        threadId,
        limit: Math.max(1, Math.min(Number(turnLimit) || 5, 20)),
        itemsView: "full",
        sortDirection: "desc",
      });
      turns = response?.data || [];
    } catch (error) {
      // Legacy histories expose turns through thread/read instead.
      try {
        const legacy = await this.client.request("thread/read", { threadId, includeTurns: true });
        turns = legacy?.thread?.turns || [];
      } catch {
        throw error;
      }
    }
    const normalizedTurns = turns.slice().reverse().map(normalizeTurn);
    const liveTurns = typeof this.client.getTurnStatesForThread === "function"
      ? this.client.getTurnStatesForThread(threadId)
      : [];
    const liveById = new Map(liveTurns.map((turn) => [turn.turnId, turn]));
    for (let index = 0; index < normalizedTurns.length; index += 1) {
      const live = liveById.get(normalizedTurns[index].id);
      if (live) {
        normalizedTurns[index] = {
          ...normalizedTurns[index],
          status: live.status,
          live_reply: live.reply || null,
          approval_requests: live.approvalRequests || [],
        };
        liveById.delete(normalizedTurns[index].id);
      }
    }
    for (const live of liveById.values()) {
      normalizedTurns.push({
        id: live.turnId,
        status: live.status,
        started_at: null,
        completed_at: null,
        duration_ms: null,
        error: null,
        user_messages: [],
        assistant_messages: live.reply ? [{ text: truncate(live.reply), phase: null }] : [],
        commands: [],
        file_changes: [],
        live_reply: live.reply || null,
        approval_requests: live.approvalRequests || [],
      });
    }
    const activeTurn = normalizedTurns.find((turn) => turn.status === "inProgress" || turn.status === "in_progress") || null;
    return {
      thread: normalizeThread(thread),
      current_status: activeTurn ? "active" : statusType(thread?.status),
      active_flags: statusFlags(thread?.status),
      turns: normalizedTurns,
      active_turn: activeTurn,
    };
  }

  async #prepareThread({ threadId, cwd, model, approvalPolicy, sandbox }) {
    if (threadId) {
      if (sandbox || approvalPolicy || model) {
        throw new Error("sandbox, approval_policy, and model overrides are only supported when creating a new thread");
      }
      const metadata = await this.client.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      const thread = metadata?.thread || metadata;
      if (thread?.canAcceptDirectInput !== true) {
        try {
          await this.client.request("thread/resume", {
            threadId,
            excludeTurns: true,
          });
        } catch (error) {
          const message = String(error?.message || "").toLowerCase();
          if (!message.includes("already loaded") && !message.includes("already resumed")) {
            throw error;
          }
        }
      }
      return { threadId, created: false, cwd: thread?.cwd || cwd || this.defaultCwd };
    }

    const startParams = {
      cwd: cwd || this.defaultCwd,
      historyMode: "paginated",
      // New remote conversations start read-only unless the caller opts in.
      sandbox: sandbox || "read-only",
    };
    if (model) {
      startParams.model = model;
    }
    if (approvalPolicy) {
      startParams.approvalPolicy = approvalPolicy;
    }
    const started = await this.client.request("thread/start", startParams);
    return {
      threadId: started?.thread?.id,
      created: true,
      cwd: started?.cwd || startParams.cwd,
    };
  }

  async chat({
    threadId = null,
    cwd = null,
    message,
    waitMs = 90_000,
    approvalPolicy = null,
    sandbox = null,
    model = null,
  } = {}) {
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("message is required");
    }
    if (message.length > 20_000) {
      throw new Error("message is too long (maximum 20,000 characters)");
    }

    const prepared = await this.#prepareThread({ threadId, cwd, model, approvalPolicy, sandbox });
    if (!prepared.threadId) {
      throw new Error("Codex did not return a thread id");
    }
    const turnParams = {
      threadId: prepared.threadId,
      input: [{ type: "text", text: message }],
    };
    // Settings for new tasks are applied at thread/start so the same policy is
    // preserved for later turns.
    const started = await this.client.request("turn/start", turnParams);
    const turnId = started?.turn?.id;
    if (!turnId) {
      throw new Error("Codex did not return a turn id");
    }

    const result = await this.client.waitForTurn(
      prepared.threadId,
      turnId,
      Math.max(1_000, Math.min(Number(waitMs) || 90_000, 300_000)),
    );
    return {
      thread_id: prepared.threadId,
      turn_id: turnId,
      created_thread: prepared.created,
      cwd: prepared.cwd,
      status: result.status,
      reply: result.reply || "",
      timed_out: Boolean(result.timedOut),
      approval_requests: result.approvalRequests || [],
    };
  }
}

export { normalizeThread, statusType, statusFlags, isoTime, truncate };
