import { config } from "./config.js";

const log = (msg, ...args) => console.log(`[renderer] ${msg}`, ...args);

let _browser = null;
let _launching = null;

const CHROME_PATHS = [
  "/home/qsrhf/.agent-browser/browsers/chrome-148.0.7778.97/chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

import { existsSync } from "fs";

/**
 * Get or launch a shared Puppeteer browser instance (headless Chrome).
 */
async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  if (_launching) return _launching;

  _launching = (async () => {
    try {
      const puppeteer = await import("puppeteer-core").then((m) => m.default || m);

      // Find Chrome executable
      const executablePath = CHROME_PATHS.find((p) => existsSync(p));
      if (!executablePath) {
        log("WARNING: no Chrome found, falling back to text mode");
        return null;
      }

      const browser = await puppeteer.launch({
        headless: "new",
        executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
      _browser = browser;
      log(`launched Chrome: ${executablePath}`);
      return browser;
    } catch (err) {
      log(`browser launch failed: ${err.message}`);
      return null;
    }
  })();

  const result = await _launching;
  _launching = null;
  return result;
}

/**
 * Render HTML to PNG buffer using Puppeteer.
 */
async function htmlToImage(html, width = 500) {
  const browser = await getBrowser();
  if (!browser) return null;

  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 800 });
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Auto-fit content height
    const bodyHandle = await page.$("body");
    const { height } = await bodyHandle.boundingBox();
    await page.setViewport({ width, height: Math.ceil(height) + 20 });

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height: Math.ceil(height) + 20 },
    });
    return screenshot;
  } finally {
    await page.close();
  }
}

// ── Progress Card HTML ──

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Generate progress card HTML.
 * tools: [{name, preview, status, duration, error}]
 * currentTool: {name, preview, startedAt} or null
 * messageDelta: accumulated text (optional)
 */
export function renderProgressHtml({ tools, currentTool, messageDelta, elapsed }) {
  const toolRows = tools.slice(-config.progressMaxTools).map((t) => {
    const icon = t.error ? "❌" : "✅";
    const dur = t.duration ? ` (${formatDuration(t.duration)})` : "";
    return `<div class="tool-row">
      <span class="icon">${icon}</span>
      <span class="name">${escapeHtml(t.name)}</span>
      <span class="dur">${dur}</span>
    </div>
    ${t.preview ? `<div class="preview">${escapeHtml(t.preview).slice(0, 120)}</div>` : ""}`;
  });

  const currentHtml = currentTool
    ? `<div class="current-tool">
        <span class="spinner">⏳</span>
        <span class="name">${escapeHtml(currentTool.name)}</span>
        ${currentTool.preview ? `<div class="preview">${escapeHtml(currentTool.preview).slice(0, 120)}</div>` : ""}
      </div>`
    : "";

  const previewHtml = messageDelta
    ? `<div class="response-preview">${escapeHtml(messageDelta.slice(-300))}</div>`
    : "";

  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    padding: 20px;
    width: 500px;
  }
  .card {
    background: #16213e;
    border-radius: 12px;
    padding: 18px;
    border: 1px solid #0f3460;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid #0f3460;
  }
  .header .icon { font-size: 22px; }
  .header .title {
    font-size: 16px;
    font-weight: 600;
    color: #e94560;
  }
  .header .elapsed {
    margin-left: auto;
    font-size: 12px;
    color: #888;
  }
  .tool-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
  }
  .tool-row .icon { font-size: 14px; flex-shrink: 0; }
  .tool-row .name { color: #53d8fb; font-family: monospace; }
  .tool-row .dur { color: #888; font-size: 11px; margin-left: auto; }
  .preview {
    font-size: 11px;
    color: #777;
    padding-left: 24px;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .current-tool {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    margin-top: 6px;
    border-top: 1px dashed #0f3460;
  }
  .spinner { animation: spin 1s linear infinite; font-size: 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .current-tool .name { color: #f5c842; font-family: monospace; font-size: 13px; }
  .response-preview {
    margin-top: 10px;
    padding: 8px;
    background: #0f3460;
    border-radius: 6px;
    font-size: 12px;
    color: #aaa;
    max-height: 60px;
    overflow: hidden;
    word-break: break-all;
  }
  .footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #0f3460;
    font-size: 11px;
    color: #555;
    text-align: right;
  }
</style></head><body>
  <div class="card">
    <div class="header">
      <span class="icon">🔧</span>
      <span class="title">Hermes 执行中</span>
      <span class="elapsed">${escapeHtml(elapsed)}</span>
    </div>
    ${toolRows.join("\n")}
    ${currentHtml}
    ${previewHtml}
    <div class="footer">${config.botName} · SSE Progress</div>
  </div>
</body></html>`;
}

/**
 * Render approval request HTML.
 */
export function renderApprovalHtml({ command, riskLevel, toolName, runId, preview }) {
  const riskColors = { high: "#e94560", medium: "#f5c842", low: "#53d8fb" };
  const riskColor = riskColors[riskLevel] || riskColors.high;

  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    padding: 20px;
    width: 500px;
  }
  .card {
    background: #16213e;
    border-radius: 12px;
    padding: 18px;
    border: 2px solid ${riskColor};
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .header .icon { font-size: 22px; }
  .header .title { font-size: 16px; font-weight: 600; color: ${riskColor}; }
  .section { margin: 10px 0; }
  .label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .value {
    font-family: monospace;
    font-size: 13px;
    background: #0f3460;
    padding: 8px;
    border-radius: 6px;
    word-break: break-all;
    max-height: 100px;
    overflow: hidden;
  }
  .actions {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid #0f3460;
    font-size: 13px;
    color: #aaa;
    line-height: 1.8;
  }
  .actions .cmd {
    color: #53d8fb;
    font-family: monospace;
    background: #0f3460;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .footer {
    margin-top: 10px;
    font-size: 11px;
    color: #555;
    text-align: right;
  }
</style></head><body>
  <div class="card">
    <div class="header">
      <span class="icon">⚠️</span>
      <span class="title">需要审批</span>
    </div>
    ${toolName ? `<div class="section"><div class="label">工具</div><div class="value">${escapeHtml(toolName)}</div></div>` : ""}
    <div class="section"><div class="label">命令</div><div class="value">${escapeHtml(command)}</div></div>
    ${preview ? `<div class="section"><div class="label">说明</div><div class="value">${escapeHtml(preview).slice(0, 200)}</div></div>` : ""}
    <div class="actions">
      回复以下内容进行审批：<br>
      <span class="cmd">批准</span> 或 <span class="cmd">通过</span> — 允许一次<br>
      <span class="cmd">拒绝</span> 或 <span class="cmd">deny</span> — 拒绝执行<br>
      <span class="cmd">始终允许</span> — 本次会话内始终允许
    </div>
    <div class="footer">run: ${escapeHtml(runId).slice(-8)}</div>
  </div>
</body></html>`;
}

/**
 * Save image to shared directory and return Docker path for OneBot.
 * Host: /home/qsrhf/napcat/config/hermes-images/
 * Docker: /app/napcat/config/hermes-images/
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
/**
 * Save image to shared directory for OneBot.
 * Returns HOST path (code runs on host, not in Docker).
 */
export function saveImageForOnebot(pngBuffer) {
  mkdirSync(HOST_IMAGE_DIR, { recursive: true });
  // Cleanup old files if too many
  try {
    const files = readdirSync(HOST_IMAGE_DIR).filter((f) => f.endsWith(".png"));
    if (files.length >= MAX_IMAGES) {
      files.sort();
      for (const f of files.slice(0, files.length - MAX_IMAGES + 1)) {
        unlinkSync(join(HOST_IMAGE_DIR, f)).catch?.(() => {});
      }
    }
  } catch {}
  const name = `progress_${Date.now()}_${randomBytes(4).toString("hex")}.png`;
  const hostPath = join(HOST_IMAGE_DIR, name);
  writeFileSync(hostPath, pngBuffer);
  return hostPath; // Return host path, not Docker path
}

/**
 * Try to render progress as image. Returns file path or null.
 */
export async function renderProgressImage(progressData) {
  if (!config.progressAsImage) return null;
  try {
    const html = renderProgressHtml(progressData);
    const buf = await htmlToImage(html);
    if (!buf) return null;
    return saveImageForOnebot(buf);
  } catch (err) {
    log(`image render failed: ${err.message}`);
    return null;
  }
}

/**
 * Render approval as image. Returns file path or null.
 */
export async function renderApprovalImage(approvalData) {
  try {
    const html = renderApprovalHtml(approvalData);
    const buf = await htmlToImage(html);
    if (!buf) return null;
    return saveImageForOnebot(buf);
  } catch (err) {
    log(`approval image render failed: ${err.message}`);
    return null;
  }
}

/**
 * Cleanup: close browser on shutdown.
 */
export async function closeRenderer() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
