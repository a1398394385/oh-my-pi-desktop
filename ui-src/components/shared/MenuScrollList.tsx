// Fixed-height row window for long dropdown sections: the first `rows` rows show, the rest scroll
// inside, and the last visible row is covered by a "scroll for more" line until the user scrolls
// this opening. resetKey re-arms the line (a menu that stays mounted passes its open flag; a menu
// that mounts per opening needs nothing). Rows are a fixed 30px (see controls.css), so the hint
// lands exactly on the last row, and that row is hidden rather than painted over — a click must
// not land on a row the user cannot see.
import { Children, cloneElement, isValidElement, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export default function MenuScrollList({ length, rows, resetKey, children }: {
  length: number;
  rows: number;
  resetKey?: unknown;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    setScrolled(false);
  }, [resetKey]);
  const covered = length > rows && !scrolled;
  return (
    <div className="mi-scroll-wrap" style={{ "--mi-scroll-rows": rows } as CSSProperties}>
      <div
        className={"mi-scroll" + (covered ? " hint" : "")}
        onScroll={(e) => {
          if (e.currentTarget.scrollTop > 0) setScrolled(true);
        }}
      >
        {covered
          ? Children.map(children, (child, i) =>
              i === rows - 1 && isValidElement(child)
                ? cloneElement(child as ReactElement<{ className?: string }>, {
                    className: `${(child as ReactElement<{ className?: string }>).props.className ?? ""} covered`.trim(),
                  })
                : child,
            )
          : children}
      </div>
      {covered && <div className="mi-scroll-hint">{t("common.scrollForMore")}</div>}
    </div>
  );
}
