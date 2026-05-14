import type { SequenceProps } from "./types.js";

export function Sequence({ lanes, messages }: SequenceProps) {
  return (
    <div
      class="seq"
      style={{ gridTemplateColumns: `repeat(${lanes.length}, 1fr)` }}
    >
      {lanes.map((lane) => (
        <div class="seq-lane" key={lane}>
          <h5>{lane}</h5>
          {messages
            .filter((m) => m.lane === lane)
            .map((m, i) => (
              <div class={`seq-msg seq-msg-${m.variant ?? "default"}`} key={i}>
                {m.text}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
