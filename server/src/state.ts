import { randomUUID } from "node:crypto";

export type ActivityKind = string;

export interface PendingMessage { kind: "message"; resolve: (text: string) => void; }
export interface PendingAsk {
  kind: "ask_user";
  resolve: (answers: { questions: AskedQuestion[]; answers: unknown[] } | { timed_out: true }) => void;
  questions: AskedQuestion[];
  timeout?: ReturnType<typeof setTimeout>;
}
export type Pending = PendingMessage | PendingAsk;

export interface AskedQuestion {
  text: string;
  help?: string;
  kind: "single" | "multi" | "freeform" | "confirm";
  options?: string[];
  placeholder?: string;
  allow_other?: boolean;
}

export interface Subscriber {
  id: string;
  send: (data: unknown) => void;
}

export interface ActivityState {
  kind: ActivityKind;
  since: number;
  color?: string;
  pendingId?: string;
  detail?: unknown;
}

export type BacklogKind = "chat" | "feedback" | "implementation";
export interface BacklogEntry {
  text: string;
  kind: BacklogKind;
  meta?: Record<string, unknown>;
}

class State {
  pending = new Map<string, Pending>();
  subscribers = new Map<string, Subscriber>();
  activity: ActivityState = { kind: "idle", since: Date.now() };
  backlog: BacklogEntry[] = [];

  enqueueOrDeliver(entry: BacklogEntry): { delivered: boolean; queued: boolean; position?: number } {
    for (const [id, p] of this.pending) {
      if (p.kind === "message") {
        this.pending.delete(id);
        p.resolve(entry.text);
        return { delivered: true, queued: false };
      }
    }
    this.backlog.push(entry);
    return { delivered: false, queued: true, position: this.backlog.length };
  }

  shiftBacklog(): BacklogEntry | undefined {
    return this.backlog.shift();
  }

  /**
   * Drop every queued backlog entry. Kept for callers that explicitly want
   * a hard reset; wait_for_message uses `takeFreshest` instead so users
   * never see a message vanish that was sent moments before the agent's
   * next listen.
   */
  clearBacklog(): number {
    const dropped = this.backlog.length;
    if (dropped === 0) return 0;
    this.backlog = [];
    this.broadcast({ type: "backlog:cleared", dropped });
    return dropped;
  }

  /**
   * Consume the most recently queued backlog entry. Any older entries are
   * dropped (broadcast as backlog:cleared so the UI can surface a hint).
   * Used at the top of wait_for_message: anything queued during the previous
   * turn reflects context the planner has already left behind, but the
   * single freshest message likely still matters to the user.
   */
  takeFreshest(): BacklogEntry | undefined {
    if (this.backlog.length === 0) return undefined;
    const freshest = this.backlog[this.backlog.length - 1];
    const skipped = this.backlog.length - 1;
    this.backlog = [];
    if (skipped > 0) {
      this.broadcast({ type: "backlog:cleared", dropped: skipped });
    }
    return freshest;
  }

  peekBacklog(): BacklogEntry[] {
    return this.backlog.slice();
  }

  setActivity(next: Partial<ActivityState> & { kind: ActivityKind }) {
    this.activity = { since: Date.now(), ...next };
    this.broadcast({ type: "state", value: this.activity });
  }

  addSubscriber(send: Subscriber["send"]): string {
    const id = randomUUID();
    this.subscribers.set(id, { id, send });
    send({ type: "state", value: this.activity });
    for (const [pendingId, p] of this.pending) {
      if (p.kind === "ask_user") {
        send({ type: "ask_user:open", id: pendingId, payload: { questions: p.questions } });
      }
    }
    return id;
  }
  removeSubscriber(id: string) { this.subscribers.delete(id); }

  broadcast(data: unknown) {
    for (const s of this.subscribers.values()) {
      try { s.send(data); } catch { /* drop dead subs silently */ }
    }
  }

  // Convenience: broadcast a server-confirmed ack for a given client request_id.
  // The browser's submit() helper waits for either the HTTP response or this
  // event (whichever resolves the matching id first) and tears down the watchdog.
  ack(request_id: string | undefined, detail: Record<string, unknown> = {}) {
    if (!request_id) return;
    this.broadcast({ type: "ack", request_id, ...detail });
  }

  registerPending(p: Pending): string {
    const id = randomUUID();
    this.pending.set(id, p);
    return id;
  }
  takePending(id: string): Pending | undefined {
    const p = this.pending.get(id);
    if (p) this.pending.delete(id);
    return p;
  }
}

export const state = new State();
