import { config } from "./config.js";
import { OneBotClient } from "./onebot.js";
import { HermesClient } from "./hermes.js";
import { readFileSync, existsSync } from "fs";

const log = (msg, ...args) => console.log(`[bridge] ${msg}`, ...args);

// ── State ──

const onebot = new OneBotClient();
const hermes = new HermesClient();

const sessions = new Map();
const activeRuns = new Map();
const pendingApprovals = new Map();

// ── Image Helpers ──

/**
 * Read local image file and return base64 data string.
 */
function readLocalImage(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const buffer = readFileSync(filePath);
  return `base64://${buffer.toString("base64")}`;
}

/**
 * Download remote image and return base64 data string.
 */
async function downloadImage(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return `base64://${buffer.toString("base64")}`;
}

/**
 * Get image data for OneBot API.
 * Supports: base64://, https://, http://, /local/path
 * Also handles Docker path -> host path conversion.
 */
async function getImageData(source) {
  if (source.startsWith("base64://")) {
    return source;
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    log(`downloading image: ${source}`);
    return await downloadImage(source);
  }

  // Convert Docker path to host path if needed
  let hostPath = source;
  if (source.startsWith("/app/napcat/config/")) {
    hostPath = source.replace("/app/napcat/config/", "/home/qsrhf/napcat/config/");
    log(`converting docker path: ${source} -> ${hostPath}`);
  }

  // Local file path
  log(`reading local image: ${hostPath}`);
  return readLocalImage(hostPath);
}

/**
 * Build image message segment.
 */
async function buildImageSegment(source) {
  try {
    const imageData = await getImageData(source);
    return { type: "image", data: { file: imageData } };
  } catch (err) {
    log(`failed to get image: ${source}: ${err.message}`);
    return null;
  }
}

// ── Session Helpers ──

function getSessionKey(route, version = 0) {
  const base = route.type === "group" ? `group:${route.groupId}` : `user:${route.userId}`;
  return version > 0 ? `${base}:v${version}` : base;
}

function getSession(route) {
  const key = getSessionKey(route);
  if (!sessions.has(key)) {
    sessions.set(key, { history: [], version: 0 });
  }
  return sessions.get(key);
}

function clearSession(route) {
  const key = getSessionKey(route);
  const sess = sessions.get(key);
  if (sess) {
    sess.version = (sess.version || 0) + 1;
    sess.history = [];
  }
  return sess?.version || 0;
}

function appendHistory(route, role, content) {
  const sess = getSession(route);
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

// ── Message Sending ──

/**
 * Send message to QQ.
 * @param {object} route - {type, groupId?, userId?}
 * @param {string|Array} message - text or message segments
 * @param {string} [replyMsgId] - optional reply target
 */
async function sendMessage(route, message, replyMsgId) {
  // Build segments array
  let segments = [];

  if (replyMsgId) {
    segments.push({ type: "reply", data: { id: String(replyMsgId) } });
  }

  if (typeof message === "string") {
    // Split long text
    const chunks = splitText(message);
    for (const chunk of chunks) {
      const msg = [...segments, { type: "text", data: { text: chunk } }];
      await sendSegments(route, msg);
    }
  } else if (Array.isArray(message)) {
    segments.push(...message);
    await sendSegments(route, segments);
  }
}

async function sendSegments(route, segments) {
  if (route.type === "group") {
    await onebot.sendGroupMsg(route.groupId, segments);
  } else {
    await onebot.sendPrivateMsg(route.userId, segments);
  }
}

function splitText(text) {
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

// ── Main Message Handler ──

/**
 * Send accumulated messageDelta as a complete message.
 * Called when tool.started fires, indicating previous message is complete.
 */
async function sendAccumulatedMessage(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;

  const output = run.messageDelta;
  if (!output?.trim()) return;

  // Clear messageDelta to avoid duplicate sending
  run.messageDelta = "";

  // Parse MEDIA: tags
  const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
  const mediaItems = [];
  let match;
  while ((match = mediaRegex.exec(output)) !== null) {
    mediaItems.push(match[1]);
  }

  // Remove MEDIA: tags from text
  const remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, "").trim();

  // Build message segments
  const segments = [];

  // Add images
  for (const mediaPath of mediaItems) {
    const imgSegment = await buildImageSegment(mediaPath);
    if (imgSegment) {
      segments.push(imgSegment);
    }
  }

  // Add text
  if (remainingText) {
    segments.push({ type: "text", data: { text: remainingText } });
  }

  // Send combined message
  if (segments.length > 0) {
    log(`sending accumulated message: ${segments.length} segments`);
    await sendMessage(run.route, segments);
  }
}

/**
 * Send tool progress update after each tool completion.
 * Shows which tools have been executed and their status.
 */
async function sendToolProgress(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;

  const tools = run.tools;
  if (tools.length === 0) return;

  // Build progress text
  const lines = [];
  const lastTool = tools[tools.length - 1];
  const icon = lastTool.error ? "❌" : "✅";
  const dur = lastTool.duration ? ` (${(lastTool.duration / 1000).toFixed(1)}s)` : "";
  
  lines.push(`${icon} ${lastTool.name}${dur}`);
  
  if (lastTool.preview) {
    lines.push(`   ${lastTool.preview.slice(0, 80)}`);
  }

  // Send progress
  await sendMessage(run.route, lines.join("\n"));
}

/**
 * Send intermediate response during execution (after tool completed).
 * Parses MEDIA: tags and sends images + text.
 */
async function sendIntermediateResponse(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;

  const output = run.messageDelta;
  if (!output?.trim()) return;

  // Clear messageDelta to avoid duplicate sending
  run.messageDelta = "";

  // Parse MEDIA: tags
  const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
  const mediaItems = [];
  let match;
  while ((match = mediaRegex.exec(output)) !== null) {
    mediaItems.push(match[1]);
  }

  // Remove MEDIA: tags from text
  const remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, "").trim();

  // Build message segments
  const segments = [];

  // Add images
  for (const mediaPath of mediaItems) {
    const imgSegment = await buildImageSegment(mediaPath);
    if (imgSegment) {
      segments.push(imgSegment);
    }
  }

  // Add text
  if (remainingText) {
    segments.push({ type: "text", data: { text: remainingText } });
  }

  // Send combined message
  if (segments.length > 0) {
    log(`sending intermediate response: ${segments.length} segments`);
    await sendMessage(run.route, segments);
  }
}

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
    await sendMessage(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, event.message_id);
    return;
  }

  // Build user prompt
  const contextLabel =
    route.type === "group"
      ? `当前来自 QQ 群 ${route.groupId}。发送者: ${event.sender?.nickname || route.userId} (${route.userId})。`
      : `当前来自 QQ 私聊。发送者: ${event.sender?.nickname || route.userId} (${route.userId})。`;
  const userPrompt = `${contextLabel}\n\n${text}`;

  const session = getSession(route);
  const sessionId = getSessionKey(route, session.version);
  appendHistory(route, "user", text);

  try {
    const { runId } = await hermes.submitRun({
      userMessage: userPrompt,
      sessionId,
      systemPrompt: config.systemPrompt || undefined,
      conversationHistory: session.history.slice(0, -1),
    });

    log(`run submitted: ${runId}`);

    const runState = {
      route,
      tools: [],
      currentTool: null,
      startedAt: Date.now(),
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
        
        // If we have accumulated messageDelta, it means the previous message is complete
        // Send it now before starting the next tool
        if (runState.messageDelta?.trim()) {
          log(`sending accumulated message before tool starts`);
          sendAccumulatedMessage(runId).catch((err) =>
            log(`send accumulated error: ${err.message}`)
          );
        }
      },

      "tool.completed"(ev) {
        runState.tools.push({
          name: ev.tool,
          duration: (ev.duration || 0) * 1000,
          error: ev.error || false,
          preview: runState.currentTool?.preview,
        });
        runState.currentTool = null;
        log(`tool.completed: ${ev.tool} (${ev.duration?.toFixed(1)}s)`);
        
        // Send progress update every 15 tools
        if (runState.tools.length % 15 === 0) {
          sendToolProgress(runId).catch((err) =>
            log(`tool progress error: ${err.message}`)
          );
        }
      },

      "message.delta"(ev) {
        runState.messageDelta += ev.delta || "";
        // Just accumulate, don't send progress cards
        // Final result will be sent on run.completed
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
    await sendMessage(route, `❌ 调用 Hermes 失败: ${err.message}`, event.message_id);
  }
}

// ── Run Completion ──

async function handleRunComplete(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  activeRuns.delete(runId);

  let output = run.finalOutput || run.messageDelta;
  if (!output?.trim()) return;

  appendHistory(run.route, "assistant", output);

  // Parse MEDIA: tags
  const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
  const mediaItems = [];
  let match;
  while ((match = mediaRegex.exec(output)) !== null) {
    mediaItems.push(match[1]);
  }

  // Remove MEDIA: tags from text
  const remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, "").trim();

  // Build message segments
  const segments = [];

  // Add images
  for (const mediaPath of mediaItems) {
    const imgSegment = await buildImageSegment(mediaPath);
    if (imgSegment) {
      segments.push(imgSegment);
    }
  }

  // Add text
  if (remainingText) {
    segments.push({ type: "text", data: { text: remainingText } });
  }

  // Send combined message
  if (segments.length > 0) {
    await sendMessage(run.route, segments, run.userMsgId);
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
      await sendMessage(route, "已停止当前任务 ✋");
      return;
    }
  }
  await sendMessage(route, "当前没有正在运行的任务");
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
      await sendMessage(run.route, "⏰ 审批超时，已自动拒绝");
    }
  }, config.approvalTimeoutSec * 1000);

  // Send approval request
  const lines = [
    `⚠️ 需要审批`,
    `命令: ${ev.command || ev.description || "未知"}`,
    ev.tool ? `工具: ${ev.tool}` : "",
    ``,
    `回复 "批准" / "通过" — 允许一次`,
    `回复 "拒绝" / "deny" — 拒绝执行`,
    `回复 "始终允许" — 本次会话内始终允许`,
  ].filter(Boolean);

  sendMessage(run.route, lines.join("\n")).catch((err) =>
    log(`approval send error: ${err.message}`)
  );
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

      await sendMessage(route, statusText, msgId);
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
  log("bridge stopped");
}

process.on("SIGINT", async () => {
  await stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stop();
  process.exit(0);
});

start().catch((err) => {
  log(`failed to start: ${err.message}`);
  process.exit(1);
});
