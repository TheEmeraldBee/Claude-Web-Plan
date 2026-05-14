import type { TimelineProps } from "./types.js";

export function Timeline({ markers }: TimelineProps) {
  return (
    <ol class="timeline">
      {markers.map((m, i) => (
        <li class={`timeline-marker ${m.done ? "done" : ""}`} key={i}>
          <span class="timeline-dot" aria-hidden="true" />
          <div class="timeline-body">
            <div class="timeline-label">{m.label}</div>
            <div class="timeline-at">{m.at}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
