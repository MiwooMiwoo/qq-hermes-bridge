import { config } from "./config.js";
import { OneBotClient } from "./onebot.js";
import { HermesClient } from "./hermes.js";
import {
  renderProgressImage,
  renderApprovalImage,
  closeRenderer,
} from "./renderer.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const log = (msg, ...args) => console.log(`[bridge] ${msg}`, ...args);

// ── Image Helpers ──

const SHARED_IMAGE_DIR = "/home/qsrhf/napcat/config/hermes-images";

/**
 * Read image file and return base64 data URI for OneBot.
 */
function imageToBase64(filePath) {
  const buffer = readFileSync(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() || "png";
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] || "image/png";
  return `base64://${buffer.toString("base64")}`;
}

/**
 * Download image from URL and return base64 data URI.
 */
async function downloadImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") || "image/jpeg";
  return `base64://${buffer.toString("base64")}`;
}

/**
 * Save image to shared directory for NapCat Docker access.
 * Returns host path.
 */
function saveToSharedDir(filename, buffer) {
  mkdirSync(SHARED_IMAGE_DIR, { recursive: true });
  const hostPath = join(SHARED_IMAGE_DIR, filename);
  writeFileSync(hostPath, buffer);
  return hostPath;
}

// ── State ──

const onebot = new OneBotClient();
const hermes = new HermesClient();

const sessions = new Map();
const activeRuns = new Map();
const pendingApprovals = new Map();

// ── Session Helpers ──

function getSessionKey(route, sessionSuffix = 0) {
  const base = route.type === "group" ? `group:${route.groupId}` : `user:${route.userId}`;
  return sessionSuffix > 0 ? `${base}:v${sessionSuffix}` : base;
}

function getSession(sessionKey) {
  if (!sessions.has(sessionKey)) {
    sessions.set(sessionKey, { history: [], sessionVersion: 0 });
  }
  return sessions.get(sessionKey);
}

function clearSession(route) {
  const baseKey = getSessionKey(route, 0);
  const sess = sessions.get(baseKey);
  if (sess) {
    sess.sessionVersion = (sess.sessionVersion || 0) + 1;
    sess.history = [];
  }
  return sess?.sessionVersion || 0;
}

function appendHistory(sessionKey, role, content) {
  const sess = getSession(sessionKey);
  sess.history.push({ role, content });
  const max = config.localHistoryMaxMessages * 2;
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
    (seg) => seg.type === "at" && String(seg.data?.qq) === String(config.botQq)
  );
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

/**
 * Send image via base64 (most reliable method).
 * @param {object} route - {type, groupId?, userId?}
 * @param {string} source - file path or URL
 */
async function sendImage(route, source) {
  try {
    let imageData;
    
    if (source.startsWith("http://") || source.startsWith("https://")) {
      // Download remote image
      log(`downloading image: ${source}`);
      imageData = await downloadImageAsBase64(source);
    } else if (source.startsWith("base64://")) {
      // Already base64
      imageData = source;
    } else {
      // Read local file
      log(`reading local image: ${source}`);
      if (!existsSync(source)) {
        throw new Error(`file not found: ${source}`);
      }
      imageData = imageToBase64(source);
    }
    
    // Send via OneBot
    if (route.type === "group") {
      await onebot.sendGroupImage(route.groupId, imageData);
    } else {
      await onebot.sendPrivateImage(route.userId, imageData);
    }
    
    log(`image sent successfully`);
    return true;
  } catch (err) {
    log(`image send failed: ${err.message}`);
    return false;
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

async function sendProgressCard(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  if (run.sendingProgress) return;
  run.sendingProgress = true;

  const elapsed = formatElapsed(Date.now() - run.startedAt);

  const progressData = {
    tools: run.tools,
    currentTool: run.currentTool,
    messageDelta: run.messageDelta,
    elapsed,
  };

  try {
    if (config.progressAsImage) {
      const imagePath = await renderProgressImage(progressData);
      if (imagePath) {
        await sendImage(run.route, imagePath);
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

  if (!canChat(route)) return;

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

  // Check for clear context command
  if (text === "清除上下文" || text === "新对话" || text.toLowerCase() === "new" || text.toLowerCase() === "reset") {
    const newVersion = clearSession(route);
    await sendReplyWithMention(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, event.message_id);
    return;
  }

  // Build user prompt
  const contextLabel =
    route.type === "group"
      ? `当前来自 QQ 群 ${route.groupId}。发送者: ${event.sender?.nickname || route.userId} (${route.userId})。请按 QQ 聊天风格回复。`
      : `当前来自 QQ 私聊。发送者: ${event.sender?.nickname || route.userId} (${route.userId})。`;
  const userPrompt = `${contextLabel}\n\n${text}`;

  const sessionKey = getSessionKey(route);
  const session = getSession(sessionKey);
  const sessionVersion = session.sessionVersion || 0;
  const versionedSessionKey = getSessionKey(route, sessionVersion);
  appendHistory(sessionKey, "user", text);

  const systemPrompt = config.systemPrompt || undefined;

  try {
    const { runId } = await hermes.submitRun({
      userMessage: userPrompt,
      sessionId: versionedSessionKey,
      systemPrompt,
      conversationHistory: session.history.slice(0, -1),
    });

    log(`run submitted: ${runId}`);

    const runState = {
      route,
      tools: [],
      currentTool: null,
      startedAt: Date.now(),
      sendingProgress: false,
      messageDelta: "",
      finalOutput: "",
      userMsgId: event.message_id,
    };
    activeRuns.set(runId, runState);

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
        // Send progress card on every reply (no rate limit)
        if (!runState.sendingProgress && runState.tools.length > 0) {
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

  let output = run.finalOutput || run.messageDelta;
  if (!output?.trim()) return;

  appendHistory(getSessionKey(run.route), "assistant", output);

  // Parse MEDIA: tags
  // Supports: MEDIA:/path/to/file.png, MEDIA:https://example.com/img.jpg
  const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
  const mediaItems = [];
  let match;

  while ((match = mediaRegex.exec(output)) !== null) {
    mediaItems.push(match[1]);
  }

  // Remove MEDIA: tags from text
  const remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, "").trim();

  // Send images first
  for (const mediaPath of mediaItems) {
    const success = await sendImage(run.route, mediaPath);
    if (!success) {
      log(`failed to send media: ${mediaPath}`);
    }
  }

  // Send remaining text
  if (remainingText) {
    await sendReplyWithMention(run.route, remainingText, run.userMsgId);
  }
}

// ── Stop Command ──

async function handleStopCommand(route) {
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

  const approval = {
    route: run.route,
    data: ev,
    runId,
  };
  pendingApprovals.set(runId, approval);

  // Auto-deny after timeout
  approval.timeoutTimer = setTimeout(async () => {
    if (pendingApprovals.has(runId)) {
      pendingApprovals.delete(runId);
      await hermes.approveRun(runId, "deny");
      await sendReply(run.route, "⏰ 审批超时，已自动拒绝");
    }
  }, config.approvalTimeoutSec * 1000);

  // Send approval request
  sendApprovalCard(run.route, ev, runId).catch((err) =>
    log(`approval card send error: ${err.message}`)
  );
}

async function sendApprovalCard(route, approval, runId) {
  try {
    const imagePath = await renderApprovalImage({
      command: approval.command || approval.description,
      riskLevel: approval.risk_level || "medium",
      toolName: approval.tool,
      runId,
      preview: approval.preview,
    });

    if (imagePath) {
      await sendImage(route, imagePath);
    } else {
      // Fallback to text
      const lines = [
        `⚠️ 需要审批`,
        `命令: ${approval.command || approval.description}`,
        ``,
        `回复 "批准" 或 "通过" 允许一次`,
        `回复 "拒绝" 或 "deny" 拒绝执行`,
        `回复 "始终允许" 本次会话内始终允许`,
      ];
      await sendReply(route, lines.join("\n"));
    }
  } catch (err) {
    log(`approval card error: ${err.message}`);
  }
}

async function handleApprovalReply(route, text, msgId) {
  for (const [runId, approval] of pendingApprovals) {
    const approvalRoute = approval.route;
    if (
      (route.type === "group" && approvalRoute.type === "group" && route.groupId === approvalRoute.groupId) ||
      (route.type === "user" && approvalRoute.type === "user" && route.userId === approvalRoute.userId)
    ) {
      const lower = text.toLowerCase();
      let action;

      if (lower === "批准" || lower === "通过" || lower === "approve" || lower === "allow") {
        action = "once";
      } else if (lower === "拒绝" || lower === "deny" || lower === "reject") {
        action = "deny";
      } else if (lower === "始终允许" || lower === "always" || lower === "session") {
        action = "session";
      } else {
        return false;
      }

      clearTimeout(approval.timeoutTimer);
      pendingApprovals.delete(runId);
      await hermes.approveRun(runId, action);

      const statusText = {
        once: "已批准（一次）✅",
        deny: "已拒绝 ❌",
        session: "已允许本次会话 ✅",
      }[action];

      await sendReplyWithMention(route, statusText, msgId);
      return true;
    }
  }
  return false;
}

// ── Lifecycle ──

export async function start() {
  log("starting bridge...");
  onebot.connect();

  onebot.on("message.group", handleMessage);
  onebot.on("message.private", handleMessage);

  log("bridge started");
}

export async function stop() {
  log("stopping bridge...");
  onebot.close();
  await closeRenderer();
  log("bridge stopped");
}

// Handle shutdown
process.on("SIGINT", async () => {
  await stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stop();
  process.exit(0);
});

// Auto-start
start().catch((err) => {
  log(`failed to start: ${err.message}`);
  process.exit(1);
});
