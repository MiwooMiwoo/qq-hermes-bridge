import { config } from "./config.js";
import http from "http";

const log = (msg, ...args) => console.log(`[hermes] ${msg}`, ...args);

/**
 * Hermes API client: async runs with SSE event streaming.
 */
export class HermesClient {
  constructor() {
    this.baseUrl = config.hermesApiUrl;
    this.apiKey = config.hermesApiKey;
  }

  _headers(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Submit a run and return {run_id, status_url, events_url}.
   */
  async submitRun({ userMessage, sessionId, systemPrompt, conversationHistory }) {
    const body = {
      input: userMessage,
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(conversationHistory?.length ? { conversation_history: conversationHistory } : {}),
    };

    const url = `${this.baseUrl}/v1/runs`;
    const resp = await fetch(url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`submitRun failed ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return {
      runId: data.run_id || data.id,
      status: data.status,
    };
  }

  /**
   * Connect to SSE events stream for a run.
   * Returns an EventEmitter-like object with 'event' callback.
   *
   * Events emitted:
   *   tool.started    {tool, preview}
   *   tool.completed  {tool, duration, error}
   *   message.delta   {delta}
   *   approval.request {run_id, command, risk_level, choices, ...}
   *   run.completed   {output, usage}
   *   run.failed      {error}
   *   reasoning.available {text}
   *   _end            (stream closed)
   *   _error          (error)
   */
  streamEvents(runId, callbacks) {
    const url = `${this.baseUrl}/v1/runs/${runId}/events`;
    const headers = this._headers({ Accept: "text/event-stream" });

    let aborted = false;
    const controller = new AbortController();

    const doConnect = async () => {
      try {
        const resp = await fetch(url, { headers, signal: controller.signal });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          callbacks._error?.(new Error(`SSE ${resp.status}: ${text.slice(0, 200)}`));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const jsonStr = line.slice(6).trim();
              if (!jsonStr) continue;
              try {
                const event = JSON.parse(jsonStr);
                const eventType = event.event || "unknown";
                const handler = callbacks[eventType];
                if (handler) handler(event);
                else callbacks._any?.(event);
              } catch {
                // non-JSON SSE data (keepalive comment)
              }
            } else if (line.startsWith(": stream closed")) {
              callbacks._end?.();
              return;
            }
          }
        }
        callbacks._end?.();
      } catch (err) {
        if (!aborted) callbacks._error?.(err);
      }
    };

    doConnect();

    return {
      abort() {
        aborted = true;
        controller.abort();
      },
    };
  }

  /**
   * Approve or deny a pending command.
   */
  async resolveApproval(runId, choice) {
    const url = `${this.baseUrl}/v1/runs/${runId}/approval`;
    const resp = await fetch(url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ choice }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Approval failed ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }

  /**
   * Stop a running agent.
   */
  async stopRun(runId) {
    const url = `${this.baseUrl}/v1/runs/${runId}/stop`;
    const resp = await fetch(url, {
      method: "POST",
      headers: this._headers(),
    });
    return resp.ok;
  }
}
