import type { PlanProps } from "./types.js";

export function Plan({ title, status = "proposed", children }: PlanProps) {
  return (
    <main class="plan" data-status={status}>
      <header class="plan-header">
        <h1>{title}</h1>
        <div class="plan-meta">
          <span class={`badge status status-${status}`}>{status}</span>
        </div>
      </header>
      <div class="plan-blocks">{children}</div>
    </main>
  );
}
