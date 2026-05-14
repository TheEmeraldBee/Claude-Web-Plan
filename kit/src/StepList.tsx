import type { StepListProps } from "./types.js";

export function StepList({ steps }: StepListProps) {
  return (
    <ol class="step-list">
      {steps.map((s, i) => (
        <li class="step" key={i}>
          <span class="step-num">{i + 1}</span>
          <div>
            <div class="step-title">{s.title}</div>
            {s.text ? <div class="step-text">{s.text}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
