// Type exemption: neither React 19's @types/react nor react-dom's runtime event registry has
// onSelectStart (the react-dom client only mentions selectstart in a priority map and never
// registers a listener; the prop is ignored at runtime).
// To keep the Sidebar JSX verbatim (zero logic changes), only this optional attribute is added
// to DOMAttributes here.
import type { ReactEventHandler } from "react";

declare module "react" {
  interface DOMAttributes<T> {
    onSelectStart?: ReactEventHandler<T> | undefined;
  }
}
