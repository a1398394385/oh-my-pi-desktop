import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ShellPage() {
  return (
    <div className="set-page" id="pg-shell">
      <div className="set-tt">Shell</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-shell"]} />
    </div>
  );
}
