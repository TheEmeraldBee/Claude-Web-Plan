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
          <div
            class="slide"
            data-slide-index={i}
            data-slide-title={s.props.title || ""}
            aria-hidden={i !== 0 ? "true" : "false"}
            key={i}
          >
            {s.props.title && <h3 class="slide-title">{s.props.title}</h3>}
            <div class="slide-body">{s.props.children}</div>
          </div>
        ))}
      </div>
      <div class="slide-progress-bar">
        <div class="slide-progress-fill" style={`width:${slides.length > 1 ? (1 / slides.length) * 100 : 100}%`}></div>
      </div>
      <div class="slideshow-nav">
        <button type="button" class="slide-prev">←</button>
        <span class="slide-counter">
          <span class="slide-cur">1</span>{" / "}<span class="slide-total">{slides.length}</span>
          {" "}<span class="slide-label"></span>
        </span>
        <div class="slideshow-nav-right">
          <button type="button" class="slide-fullscreen" title="Toggle fullscreen (F)">⛶</button>
          <button type="button" class="slide-next">→</button>
        </div>
      </div>
    </div>
  );
}
