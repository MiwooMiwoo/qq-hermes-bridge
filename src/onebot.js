import WebSocket from "ws";
import { config } from "./config.js";

const log = (msg, ...args) => console.log(`[onebot] ${msg}`, ...args);

/**
 * Minimal OneBot v11 WebSocket client for NapCat.
 */
export class OneBotClient {
  constructor() {
    this.ws = null;
    this.selfId = config.botQq;
    this._handlers = new Map();
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

  /**
   * Send message (text, image, or mixed segments).
   * @param {string} messageType - "group" or "private"
   * @param {number} targetId - groupId or userId
   * @param {string|Array} message - text string or array of message segments
   */
  async sendMsg(messageType, targetId, message) {
    const params = { message_type: messageType, message };
    if (messageType === "group") {
      params.group_id = Number(targetId);
    } else {
      params.user_id = Number(targetId);
    }
    return this.api("send_msg", params);
  }

  /**
   * Send group message.
   */
  async sendGroupMsg(groupId, message) {
    return this.sendMsg("group", groupId, message);
  }

  /**
   * Send private message.
   */
  async sendPrivateMsg(userId, message) {
    return this.sendMsg("private", userId, message);
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
