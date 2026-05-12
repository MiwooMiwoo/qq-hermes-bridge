import WebSocket from "ws";
import { config } from "./config.js";

const log = (msg, ...args) => console.log(`[onebot] ${msg}`, ...args);

/**
 * Minimal OneBot v11 WebSocket client.
 * Handles connect/reconnect, event dispatch, and message sending.
 */
export class OneBotClient {
  constructor() {
    this.ws = null;
    this.selfId = config.botQq;
    this._handlers = new Map(); // event_type -> [callback]
    this._reconnectTimer = null;
    this._alive = false;
    this._apiCallbacks = new Map();
    this._apiSeq = 0;
  }

  on(eventType, cb) {
    if (!this._handlers.has(eventType)) this._handlers.set(eventType, []);
    this._handlers.get(eventType).push(cb);
    return this;
  }

  connect() {
    if (this.ws) return;
    this._alive = true;

    const url = config.onebotAccessToken
      ? `${config.onebotWsUrl}?access_token=${config.onebotAccessToken}`
      : config.onebotWsUrl;

    log(`connecting to ${config.onebotWsUrl}`);
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      log("connected");
      this._emit("_connected");
    });

    this.ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // API response
      if (data.echo !== undefined) {
        const cb = this._apiCallbacks.get(data.echo);
        if (cb) {
          this._apiCallbacks.delete(data.echo);
          cb(data);
        }
        return;
      }

      // Event
      if (data.post_type) {
        this._emit(data.post_type, data);
        if (data.post_type === "message") {
          this._emit(`message.${data.message_type}`, data);
        }
      }
    });

    this.ws.on("close", (code, reason) => {
      log(`disconnected: ${code} ${reason}`);
      this.ws = null;
      this._emit("_disconnected");
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log(`error: ${err.message}`);
    });
  }

  _scheduleReconnect() {
    if (!this._alive || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._alive) this.connect();
    }, 3000);
  }

  _emit(eventType, data) {
    const handlers = this._handlers.get(eventType) || [];
    for (const cb of handlers) {
      try {
        cb(data);
      } catch (err) {
        log(`handler error for ${eventType}: ${err.message}`);
      }
    }
  }

  /**
   * Send OneBot API request and return response.
   */
  async api(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket not connected"));
      }
      const echo = String(++this._apiSeq);
      const timeout = setTimeout(() => {
        this._apiCallbacks.delete(echo);
        reject(new Error(`API timeout: ${action}`));
      }, 30000);

      this._apiCallbacks.set(echo, (resp) => {
        clearTimeout(timeout);
        if (resp.retcode === 0) {
          resolve(resp.data);
        } else {
          reject(new Error(`API error ${resp.retcode}: ${resp.msg || resp.wording}`));
        }
      });

      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  // ── Convenience Methods ──

  async sendGroupMsg(groupId, message) {
    return this.api("send_group_msg", {
      group_id: Number(groupId),
      message,
    });
  }

  async sendPrivateMsg(userId, message) {
    return this.api("send_private_msg", {
      user_id: Number(userId),
      message,
    });
  }

  async sendGroupImage(groupId, imageUrl) {
    return this.sendGroupMsg(groupId, [
      { type: "image", data: { file: imageUrl } },
    ]);
  }

  async sendPrivateImage(userId, imageUrl) {
    return this.sendPrivateMsg(userId, [
      { type: "image", data: { file: imageUrl } },
    ]);
  }

  /**
   * Send a forward (合并转发) message to a group.
   * nodes: [{name, uin, content: string|array}]
   */
  async sendGroupForwardMsg(groupId, nodes) {
    return this.api("send_group_forward_msg", {
      group_id: Number(groupId),
      message: nodes.map((n) => ({
        type: "node",
        data: {
          nickname: n.name || config.botName,
          user_id: String(n.uin || config.botQq),
          content: typeof n.content === "string"
            ? [{ type: "text", data: { text: n.content } }]
            : n.content,
        },
      })),
    });
  }

  /**
   * Send a reply message referencing a specific message ID.
   */
  async sendGroupReply(groupId, message, replyMsgId) {
    const content = typeof message === "string"
      ? [{ type: "text", data: { text: message } }]
      : message;
    return this.sendGroupMsg(groupId, [
      { type: "reply", data: { id: String(replyMsgId) } },
      ...content,
    ]);
  }

  close() {
    this._alive = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
