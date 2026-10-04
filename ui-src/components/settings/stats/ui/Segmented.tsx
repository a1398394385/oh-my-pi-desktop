import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "sm";
  "aria-label"?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  // The capsule highlights the hovered option (preview) or, when not hovering,
  // the selected one. Nothing is highlighted by default beyond the selection.
  const [hover, setHover] = useState<T | null>(null);
  const thumbValue = hover ?? value;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const active = root?.querySelector<HTMLElement>(`[data-value="${thumbValue}"]`);
    if (!root || !active) {
      setThumb(null);
      return;
    }
    // Inset the highlight 3px on each side so it sits close to (but never
    // touches) the separators between options.
    const measure = () =>
      setThumb({ left: active.offsetLeft + 3, width: Math.max(0, active.offsetWidth - 6) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value, options, thumbValue]);

  return (
    <div
      ref={rootRef}
      className="segmented"
      data-size={size}
      role="radiogroup"
      aria-label={ariaLabel}
      onMouseLeave={() => setHover(null)}
    >
      {thumb && (
        <span
          className="segmented-thumb"
          data-active={thumbValue === value}
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="segmented-option"
          data-value={option.value}
          data-active={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
          onMouseEnter={() => setHover(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
