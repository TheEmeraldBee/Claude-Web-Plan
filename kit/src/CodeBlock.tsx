import type { CodeBlockProps } from "./types.js";

export function CodeBlock({ lang, children }: CodeBlockProps) {
  return (
    <div class="code-block-wrap">
      <pre class={`code-block lang-${lang ?? "text"}`}>
        <code class={`language-${lang ?? "none"}`}>{children}</code>
      </pre>
      <button type="button" class="copy-btn" aria-label="Copy code">Copy</button>
    </div>
  );
}
