import { config } from "./config.js";
import { OneBotClient } from "./onebot.js";
import { HermesClient } from "./hermes.js";
import {
  renderProgressImage,
  renderApprovalImage,
  closeRenderer,
} from "./renderer.js";

const log = (msg, ...args) => console.log(`[bridge] ${msg}`, ...args);

// ── State ──

const onebot = new OneBotClient();
const hermes = new HermesClient();

// Per-chat session state: sessionId -> {history: [{role, content}], lastRunId}
const sessions = new Map();

// Active runs: runId -> {route, stream, tools, currentTool, startedAt, messageDelta, lastProgressSent, sendingProgress}
const activeRuns = new Map();

// Pending approvals: runId -> {route, data, timeoutTimer}
const pendingApprovals = new Map();

// ── Session Helpers ──

function getSessionKey(route) {
  return route.type === "group" ? `group:${route.groupId}` : `user:${route.userId}`;
}

function getSession(sessionKey) {
  if (!sessions.has(sessionKey)) {
    sessions.set(sessionKey, { history: [] });
  }
  return sessions.get(sessionKey);
}

function appendHistory(sessionKey, role, content) {
  const sess = getSession(sessionKey);
  sess.history.push({ role, content });
  // Trim to max
  const max = config.localHistoryMaxMessages * 2; // user+assistant pairs
  if (sess.history.length > max) {
    sess.history = sess.history.slice(-max);
  }
}

// ── Access Control ──

function isAdmin(userId) {
  return config.admins.has(String(userId));
}

function canChat(route) {
  const uid = String(route.userId);
  if (config.blockedUsers.has(uid)) return false;
  if (config.allowedUsers.size > 0 && !config.allowedUsers.has(uid) && !isAdmin(uid)) {
    return false;
  }
  if (route.type === "group" && config.allowedGroups.size > 0) {
    if (!config.allowedGroups.has(String(route.groupId))) return false;
  }
  return true;
}

// ── Trigger Logic ──

function hasAtSelf(message) {
  if (!Array.isArray(message)) return false;
  return message.some(
    (seg) =>
      seg.type === "at" &&
      String(seg.data?.qq) === String(config.botQq)
  );
}

function hasReplyToBot(message) {
  // We check this async later; for now just check if there's a reply segment
  return Array.isArray(message) && message.some((seg) => seg.type === "reply");
}

function extractText(message) {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .filter((seg) => seg.type === "text")
    .map((seg) => seg.data?.text || "")
    .join("")
    .trim();
}

function containsKeyword(text) {
  const lower = text.toLowerCase();
  for (const kw of config.keywordTriggers) {
    if (lower.includes(kw)) return kw;
  }
  return "";
}

function shouldTrigger(event) {
  if (event.message_type !== "group") return { triggered: true, reason: "private" };

  const text = extractText(event.message);
  const mentioned = hasAtSelf(event.message);
  const keywordHit = containsKeyword(text);

  if (mentioned) return { triggered: true, reason: "mention" };
  if (keywordHit) return { triggered: true, reason: `keyword:${keywordHit}` };
  if (!config.requireMention) return { triggered: true, reason: "bare" };

  return { triggered: false };
}

// ── Reply Helpers ──

async function sendReply(route, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    if (route.type === "group") {
      await onebot.sendGroupMsg(route.groupId, chunk);
    } else {
      await onebot.sendPrivateMsg(route.userId, chunk);
    }
  }
}

async function sendReplyImage(route, imagePath) {
  try {
    if (route.type === "group") {
      await onebot.sendGroupImage(route.groupId, `file://${imagePath}`);
    } else {
      await onebot.sendPrivateImage(route.userId, `file://${imagePath}`);
    }
  } catch (err) {
    log(`image send failed: ${err.message}, falling back to text`);
  }
}

async function sendReplyWithMention(route, text, userMsgId) {
  if (route.type === "group" && userMsgId) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await onebot.sendGroupReply(route.groupId, chunk, userMsgId);
    }
  } else {
    await sendReply(route, text);
  }
}

function splitMessage(text) {
  if (text.length <= config.maxMessageLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= config.maxMessageLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline or space
    let splitIdx = remaining.lastIndexOf("\n", config.maxMessageLength);
    if (splitIdx < config.maxMessageLength * 0.3) {
      splitIdx = remaining.lastIndexOf(" ", config.maxMessageLength);
    }
    if (splitIdx < config.maxMessageLength * 0.3) {
      splitIdx = config.maxMessageLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

// ── Progress Tracking ──

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function shouldSendProgress(runState) {
  if (runState.sendingProgress) return false; // already sending, skip
  const now = Date.now();
  const elapsed = (now - runState.lastProgressSent) / 1000;
  return elapsed >= config.progressRateLimitSec;
}

async function sendProgressCard(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;

  // Lock to prevent concurrent sends
  if (run.sendingProgress) return;
  run.sendingProgress = true;

  const now = Date.now();
  const elapsed = formatElapsed(now - run.startedAt);

  const progressData = {
    tools: run.tools,
    currentTool: run.currentTool,
    messageDelta: run.messageDelta,
    elapsed,
  };

  // Try image first
  try {
    if (config.progressAsImage) {
      const imagePath = await renderProgressImage(progressData);
      if (imagePath) {
        await sendReplyImage(run.route, imagePath);
        run.lastProgressSent = now;
        return;
      }
    }

    // Fallback to text
    const lines = [`⏳ Hermes 执行中 (${elapsed})`];
    for (const t of run.tools.slice(-8)) {
      const icon = t.error ? "❌" : "✅";
      const dur = t.duration ? ` (${formatElapsed(t.duration)})` : "";
      const preview = t.preview ? ` → ${t.preview.slice(0, 80)}` : "";
      lines.push(`${icon} ${t.name}${dur}${preview}`);
    }
    if (run.currentTool) {
      const preview = run.currentTool.preview ? ` → ${run.currentTool.preview.slice(0, 80)}` : "";
      lines.push(`⏳ ${run.currentTool.name}...${preview}`);
    }
    await sendReply(run.route, lines.join("\n"));
    run.lastProgressSent = now;
  } finally {
    run.sendingProgress = false;
  }
}

// ── Main Message Handler ──

async function handleMessage(event) {
  const route =
    event.message_type === "group"
      ? { type: "group", groupId: event.group_id, userId: event.user_id }
      : { type: "user", userId: event.user_id };

  // Access control
  if (!canChat(route)) return;

  // Trigger check
  const { triggered, reason } = shouldTrigger(event);
  if (!triggered) return;

  log(`triggered: ${reason} from ${route.userId} in ${route.type}:${route.groupId || route.userId}`);

  const text = extractText(event.message);
  if (!text) return;

  // Check for approval replies
  if (route.type === "group") {
    const handled = await handleApprovalReply(route, text, event.message_id);
    if (handled) return;
  }

  // Check for stop command
  if (text === "停止" || text.toLowerCase() === "stop") {
    await handleStopCommand(route);
    return;
  }

  // Build user prompt with context label
  const contextLabel =
    route.type === "group"
      ? `当前来自 QQ 群 ${route.groupId}。发送者: ${event.sender?.nickname || route.userId} (${route.userId})。请按 QQ 聊天风格回复。`
      : `当前来自 QQ 私聊。发送者: ${event.sender?.nickname || route.userId} (${route.userId})。`;
  const userPrompt = `${contextLabel}\n\n${text}`;

  const sessionKey = getSessionKey(route);
  const session = getSession(sessionKey);
  appendHistory(sessionKey, "user", text);

  const systemPrompt = config.systemPrompt || undefined;

  try {
    // Submit async run
    const { runId } = await hermes.submitRun({
      userMessage: userPrompt,
      sessionId: sessionKey,
      systemPrompt,
      conversationHistory: session.history.slice(0, -1), // exclude just-added message
    });

    log(`run submitted: ${runId}`);

    // Track run state
    const runState = {
      route,
      tools: [],
      currentTool: null,
      startedAt: Date.now(),
      lastProgressSent: 0,
      sendingProgress: false,
      messageDelta: "",
      finalOutput: "",
      userMsgId: event.message_id,
    };
    activeRuns.set(runId, runState);

    // Connect to SSE events
    const stream = hermes.streamEvents(runId, {
      "tool.started"(ev) {
        runState.currentTool = {
          name: ev.tool,
          preview: ev.preview,
          startedAt: ev.timestamp * 1000,
        };
        log(`tool.started: ${ev.tool}`);
      },

      "tool.completed"(ev) {
        const tool = {
          name: ev.tool,
          duration: (ev.duration || 0) * 1000,
          error: ev.error || false,
          preview: runState.currentTool?.preview,
        };
        runState.tools.push(tool);
        runState.currentTool = null;
        log(`tool.completed: ${ev.tool} (${ev.duration?.toFixed(1)}s)`);
      },

      "message.delta"(ev) {
        runState.messageDelta += ev.delta || "";
        // Check if we should send a progress update
        if (shouldSendProgress(runState) && runState.tools.length > 0) {
          sendProgressCard(runId).catch((err) =>
            log(`progress send error: ${err.message}`)
          );
        }
      },

      "approval.request"(ev) {
        log(`approval.request for run ${runId}`);
        handleApprovalRequest(runId, ev);
      },

      "run.completed"(ev) {
        runState.finalOutput = ev.output || "";
        log(`run completed: ${runId}`);
      },

      "run.failed"(ev) {
        runState.finalOutput = `❌ 执行失败: ${ev.error || "unknown error"}`;
        log(`run failed: ${runId}: ${ev.error}`);
      },

      "reasoning.available"(ev) {
        // Optional: could display reasoning
      },

      _end() {
        log(`SSE stream ended for ${runId}`);
        handleRunComplete(runId);
      },

      _error(err) {
        log(`SSE error for ${runId}: ${err.message}`);
        handleRunComplete(runId);
      },
    });

    runState.stream = stream;
  } catch (err) {
    log(`submit error: ${err.message}`);
    await sendReplyWithMention(route, `❌ 调用 Hermes 失败: ${err.message}`, event.message_id);
  }
}

// ── Run Completion ──

async function handleRunComplete(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  activeRuns.delete(runId);

  // Send final response
  const output = run.finalOutput || run.messageDelta;
  if (output?.trim()) {
    appendHistory(getSessionKey(run.route), "assistant", output);
    await sendReplyWithMention(run.route, output, run.userMsgId);
  }
}

// ── Stop Command ──

async function handleStopCommand(route) {
  // Find active run for this chat
  for (const [runId, run] of activeRuns) {
    if (
      (route.type === "group" && run.route.groupId === route.groupId) ||
      (route.type === "user" && run.route.userId === route.userId)
    ) {
      await hermes.stopRun(runId);
      await sendReply(route, "已停止当前任务 ✋");
      return;
    }
  }
  await sendReply(route, "当前没有正在运行的任务");
}

// ── Approval Handling ──

function handleApprovalRequest(runId, ev) {
  if (!config.approvalEnabled) return;

  const run = activeRuns.get(runId);
  if (!run) return;

  const route = run.route;
  const command = ev.command || "unknown command";
  const description = ev.description || "";
  const patternKey = ev.pattern_key || "";

  // Derive risk level from pattern key
  const riskLevel = /rm|delete|sudo|chmod|chown|kill|reboot|shutdown/.test(patternKey)
    ? "high"
    : /curl|wget|pip|npm|apt|docker/.test(patternKey)
    ? "medium"
    : "low";

  // Store pending approval
  const approval = {
    runId,
    route,
    data: ev,
    createdAt: Date.now(),
  };
  pendingApprovals.set(runId, approval);

  // Auto-deny timeout
  if (config.approvalTimeoutSec > 0) {
    approval.timeoutTimer = setTimeout(async () => {
      if (pendingApprovals.has(runId)) {
        pendingApprovals.delete(runId);
        try {
          await hermes.resolveApproval(runId, "deny");
          await sendReply(route, `⏱️ 审批超时，已自动拒绝: ${command.slice(0, 100)}`);
        } catch {}
      }
    }, config.approvalTimeoutSec * 1000);
  }

  // Send approval card
  sendApprovalCard(runId, command, riskLevel).catch((err) =>
    log(`approval card error: ${err.message}`)
  );
}

async function sendApprovalCard(runId, command, riskLevel) {
  const approval = pendingApprovals.get(runId);
  if (!approval) return;

  const route = approval.route;
  const ev = approval.data;

  // Try image first
  const imagePath = await renderApprovalImage({
    command,
    riskLevel,
    toolName: ev.pattern_key || "",
    runId,
    preview: ev.description || "",
  });

  if (imagePath) {
    await sendReplyImage(route, imagePath);
    // Also send a text message with the reply instructions for easy copy
    await sendReply(
      route,
      `⚠️ 上方命令需要审批。回复 "批准" / "拒绝" / "始终允许" 来处理。`
    );
  } else {
    // Text fallback
    const lines = [
      `⚠️ 需要审批`,
      patternKey ? `模式: ${patternKey}` : "",
      `命令: ${command.slice(0, 300)}`,
      description ? `说明: ${description.slice(0, 200)}` : "",
      riskLevel === "high" ? `风险: 🔴 高` : riskLevel === "medium" ? `风险: 🟡 中` : `风险: 🔵 低`,
      "",
      `回复 "批准" / "拒绝" / "始终允许" 来处理`,
      `(run: ${runId.slice(-8)})`,
    ].filter(Boolean);
    await sendReply(route, lines.join("\n"));
  }
}

async function handleApprovalReply(route, text, msgId) {
  // Find pending approval for this chat
  for (const [runId, approval] of pendingApprovals) {
    const approvalRoute = approval.route;
    if (
      (route.type === "group" && approvalRoute.groupId === route.groupId) ||
      (route.type === "user" && approvalRoute.userId === route.userId)
    ) {
      const lower = text.toLowerCase().trim();
      let choice = null;

      if (["批准", "通过", "approve", "ok", "允许"].some((k) => lower.includes(k))) {
        choice = "once";
      } else if (["拒绝", "deny", "不批准", "不允许"].some((k) => lower.includes(k))) {
        choice = "deny";
      } else if (["始终允许", "always", "始终批准", "全部允许"].some((k) => lower.includes(k))) {
        choice = "always";
      } else if (["本次允许", "session"].some((k) => lower.includes(k))) {
        choice = "session";
      }

      if (!choice) return false;

      // Clear timeout
      if (approval.timeoutTimer) clearTimeout(approval.timeoutTimer);
      pendingApprovals.delete(runId);

      try {
        await hermes.resolveApproval(runId, choice);
        const labels = {
          once: "已批准（一次）✅",
          deny: "已拒绝 ❌",
          always: "已设置始终允许 ♾️",
          session: "已允许本次会话 ✅",
        };
        await sendReplyWithMention(route, labels[choice] || `已处理: ${choice}`, msgId);
        log(`approval resolved: ${runId} -> ${choice}`);
      } catch (err) {
        await sendReply(route, `审批处理失败: ${err.message}`);
        log(`approval error: ${err.message}`);
      }

      return true;
    }
  }
  return false;
}

// ── Bootstrap ──

async function main() {
  log("=== QQ-Hermes Bridge starting ===");
  log(`Bot: ${config.botName} (${config.botQq})`);
  log(`Hermes API: ${config.hermesApiUrl}`);
  log(`NapCat WS: ${config.onebotWsUrl}`);
  log(`Progress: image=${config.progressAsImage}, rate=${config.progressRateLimitSec}s`);
  log(`Approval: enabled=${config.approvalEnabled}, timeout=${config.approvalTimeoutSec}s`);

  // Connect to NapCat
  onebot.on("_connected", () => {
    log("NapCat connected, listening for messages");
  });

  onebot.on("message.group", (event) => {
    handleMessage(event).catch((err) =>
      log(`handleMessage error: ${err.message}`)
    );
  });

  onebot.on("message.private", (event) => {
    handleMessage(event).catch((err) =>
      log(`handleMessage error: ${err.message}`)
    );
  });

  onebot.connect();

  // Graceful shutdown
  const shutdown = async () => {
    log("shutting down...");
    onebot.close();
    await closeRenderer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
