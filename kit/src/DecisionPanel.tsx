import type { DecisionPanelProps } from "./types.js";

export function DecisionPanel({ questions }: DecisionPanelProps) {
  return (
    <div class="qpanel" data-decision-panel>
      {questions.map((q, qi) => (
        <div class="question" data-q-kind={q.kind} key={qi}>
          <div class="q-text">{q.text}</div>
          {q.help ? <div class="q-help">{q.help}</div> : null}
          {q.kind === "freeform" ? (
            <textarea
              class="q-freeform"
              rows={3}
              placeholder={q.placeholder ?? ""}
            />
          ) : (
            <div class="q-options">
              {(q.options ?? []).map((opt, oi) => (
                <label class="q-option" key={oi}>
                  <input
                    type={q.kind === "single" ? "radio" : "checkbox"}
                    name={`q-${qi}`}
                    value={opt.value}
                  />
                  <div class="q-option-text">
                    {opt.value}
                    {opt.hint ? (
                      <span class="q-option-hint">{opt.hint}</span>
                    ) : null}
                  </div>
                </label>
              ))}
              {q.allow_other ? (
                <label class="q-option q-option-other">
                  <input
                    type={q.kind === "single" ? "radio" : "checkbox"}
                    name={`q-${qi}`}
                    value="__other__"
                  />
                  <div class="q-option-text">Other…</div>
                </label>
              ) : null}
              {q.allow_other ? (
                <input
                  type="text"
                  class="q-other-input"
                  placeholder="Please specify…"
                />
              ) : null}
            </div>
          )}
        </div>
      ))}
      <div class="qpanel-footer">
        <div class="qpanel-hint">
          Answers are sent back to Claude when you submit.
        </div>
        <button type="button" class="btn-submit-answers">
          Submit answers
        </button>
      </div>
    </div>
  );
}
