import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function ShellPage() {
  return (
    <div className="set-page" id="pg-shell">
      <div className="set-tt">Shell</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-shell"]} />
    </div>
  );
}
