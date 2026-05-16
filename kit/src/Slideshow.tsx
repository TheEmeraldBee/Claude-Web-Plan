import { toChildArray } from "preact";
import type { ComponentChildren, VNode } from "preact";

export interface SlideProps {
  title?: string;
  children?: ComponentChildren;
}

export interface SlideshowProps {
  children?: ComponentChildren;
}

export function Slide({ children }: SlideProps) {
  return <>{children}</>;
}

export function Slideshow({ children }: SlideshowProps) {
  const slides = toChildArray(children).filter(
    (c): c is VNode<SlideProps> => typeof c === "object" && c !== null && "props" in c,
  );
  if (!slides.length) return null;
  return (
    <div class="slideshow" data-slideshow="">
      <div class="slideshow-viewport">
        {slides.map((s, i) => (
          <div class="slide" data-slide-index={i} aria-hidden={i !== 0 ? "true" : undefined} key={i}>
            {s.props.title && <h3 class="slide-title">{s.props.title}</h3>}
            <div class="slide-body">{s.props.children}</div>
          </div>
        ))}
      </div>
      <div class="slideshow-nav">
        <button type="button" class="slide-prev">←</button>
        <span class="slide-counter">
          <span class="slide-cur">1</span>{" / "}<span class="slide-total">{slides.length}</span>
        </span>
        <button type="button" class="slide-next">→</button>
      </div>
    </div>
  );
}
