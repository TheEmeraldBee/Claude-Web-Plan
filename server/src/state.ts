import { randomUUID } from "node:crypto";

export type ActivityKind = "idle" | "thinking" | "asking" | "waiting" | "implementing" | "errored";

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
}

export interface Subscriber {
  id: string;
  send: (data: unknown) => void;
}

export interface ActivityState {
  kind: ActivityKind;
  since: number;
  pendingId?: string;
  detail?: unknown;
}

class State {
  pending = new Map<string, Pending>();
  subscribers = new Map<string, Subscriber>();
  activity: ActivityState = { kind: "idle", since: Date.now() };

  setActivity(next: Partial<ActivityState> & { kind: ActivityKind }) {
    this.activity = { since: Date.now(), ...next };
    this.broadcast({ type: "state", value: this.activity });
  }

  addSubscriber(send: Subscriber["send"]): string {
    const id = randomUUID();
    this.subscribers.set(id, { id, send });
    // Current state
    send({ type: "state", value: this.activity });
    // Replay open ask_user so a fresh tab (or a reload after the original
    // broadcast was missed) re-renders the modal. The agent is still blocked
    // on the same pending Promise — answering on this client will resolve it.
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
