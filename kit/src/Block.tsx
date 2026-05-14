import type { BlockProps } from "./types.js";

export function Block({ id, kind, title, children }: BlockProps) {
  return (
    <section class="block" data-block-id={id} data-block-kind={kind}>
      {title ? <h3 class="block-title">{title}</h3> : null}
      <div class="block-body">{children}</div>
      <div class="block-toolbar" data-block-toolbar={id}>
        <button type="button" class="comment-btn" data-comment-for={id}>
          + comment
        </button>
      </div>
    </section>
  );
}
