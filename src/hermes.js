import { config } from "./config.js";

const log = (msg, ...args) => console.log(`[hermes] ${msg}`, ...args);

/**
 * Hermes API client: async runs with SSE event streaming.
 */
export class HermesClient {
  constructor() {
    this.baseUrl = config.hermesApiUrl;
    this.apiKey = config.hermesApiKey;
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
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

    const resp = await fetch(`${this.baseUrl}/v1/runs`, {
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
      statusUrl: data.status_url,
      eventsUrl: data.events_url,
    };
  }

  /**
   * Stream SSE events for a run.
   * @param {string} runId
   * @param {Object} handlers - {eventType: callback}
   * @returns {Object} - {close()}
   */
  streamEvents(runId, handlers) {
    const url = `${this.baseUrl}/v1/runs/${runId}/events`;
    let closed = false;
    let controller = new AbortController();

    const run = async () => {
      try {
        const resp = await fetch(url, {
          headers: this._headers(),
          signal: controller.signal,
        });

        if (!resp.ok) {
          throw new Error(`SSE failed: ${resp.status}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                // Use event from SSE event line, or from data object
                const eventType = currentEvent || data.event || data.type;
                
                if (eventType) {
                  log(`SSE event: ${eventType}`);
                  const handler = handlers[eventType];
                  if (handler) {
                    handler(data);
                  }
                  // Also call _end handler for run.completed/failed
                  if (eventType === "run.completed" || eventType === "run.failed") {
                    handlers._end?.();
                  }
                }
                
                currentEvent = ""; // Reset for next event
              } catch (e) {
                log(`SSE parse error: ${e.message}`);
              }
            }
          }
        }

        handlers._end?.();
      } catch (err) {
        if (!closed) {
          handlers._error?.(err);
        }
      }
    };

    run();

    return {
      close() {
        closed = true;
        controller.abort();
      },
    };
  }

  /**
   * Stop a running task.
   */
  async stopRun(runId) {
    const resp = await fetch(`${this.baseUrl}/v1/runs/${runId}/stop`, {
      method: "POST",
      headers: this._headers(),
    });
    return resp.ok;
  }

  /**
   * Approve or deny a pending command.
   */
  async approveRun(runId, action) {
    const resp = await fetch(`${this.baseUrl}/v1/runs/${runId}/approve`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ action }),
    });
    return resp.ok;
  }
}
