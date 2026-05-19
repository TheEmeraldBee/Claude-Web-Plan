import { randomUUID } from "node:crypto";

export type ActivityKind = string;

export interface PendingMessage { kind: "message"; resolve: (text: string) => void; }
export interface PendingAsk {
  kind: "ask_user";
  resolve: (answers: { questions: AskedQuestion[]; answers: unknown[] } | { timed_out: true }) => void;
  questions: AskedQuestion[];
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
   * Drop every queued backlog entry. Called on entry to wait_for_message:
   * anything queued during the previous turn reflects a context the agent
   * has already left behind, so the planner should listen fresh for the
   * next real message instead of replaying stale work.
   *
   * Broadcasts `backlog:cleared` (with the dropped count) so the browser
   * can surface a hint that older messages were discarded.
   */
  clearBacklog(): number {
    const dropped = this.backlog.length;
    if (dropped === 0) return 0;
    this.backlog = [];
    this.broadcast({ type: "backlog:cleared", dropped });
    return dropped;
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
