import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function parseList(s) {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function parseBool(s, def = false) {
  if (s === undefined || s === "") return def;
  return s === "true" || s === "1";
}

function parseInt(s, def = 0) {
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

const env = { ...loadEnv(), ...process.env };

export const config = {
  // NapCat
  onebotWsUrl: env.ONEBOT_WS_URL || "ws://127.0.0.1:3001",
  onebotAccessToken: env.ONEBOT_ACCESS_TOKEN || "",

  // Hermes
  hermesApiUrl: env.HERMES_API_URL || "http://127.0.0.1:8642",
  hermesApiKey: env.HERMES_API_KEY || "",

  // Bot identity
  botQq: env.BOT_QQ || "",
  botName: env.BOT_NAME || "小喵",

  // Access control
  admins: new Set(parseList(env.ADMINS)),
  allowedGroups: new Set(parseList(env.ALLOWED_GROUPS)),
  allowedUsers: new Set(parseList(env.ALLOWED_USERS)),
  blockedUsers: new Set(parseList(env.BLOCKED_USERS)),

  // Trigger
  requireMention: parseBool(env.REQUIRE_MENTION, true),
  keywordTriggers: parseList(env.KEYWORD_TRIGGERS).map((k) => k.toLowerCase()),

  // Messages
  maxMessageLength: parseInt(env.MAX_MESSAGE_LENGTH, 1200),
  systemPrompt: env.SYSTEM_PROMPT || "",

  // Approval
  approvalEnabled: parseBool(env.APPROVAL_ENABLED, true),
  approvalTimeoutSec: parseInt(env.APPROVAL_TIMEOUT_SECONDS, 300),

  // Session
  localHistoryMaxMessages: parseInt(env.LOCAL_HISTORY_MAX_MESSAGES, 24),

  // Paths
  rootDir: ROOT,
};
