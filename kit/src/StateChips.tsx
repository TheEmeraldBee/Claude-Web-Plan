import type { ClaudeState, StateChipsProps } from "./types.js";

const ALL: { name: ClaudeState; what: string }[] = [
  { name: "idle", what: "no agent" },
  { name: "thinking", what: "between calls" },
  { name: "asking", what: "ask_user" },
  { name: "waiting", what: "wait_for_message" },
  { name: "implementing", what: "edits running" },
  { name: "errored", what: "tool threw" },
];

export function StateChips({ current }: StateChipsProps) {
  return (
    <div class="state-row" data-current={current ?? ""}>
      {ALL.map((s) => (
        <div
          class={`state-chip ${current === s.name ? "active" : ""}`}
          key={s.name}
        >
          <span class={`state-dot state-dot-${s.name}`} />
          <span class="state-name">{s.name}</span>
          <span class="state-what">{s.what}</span>
        </div>
      ))}
    </div>
  );
}
