import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function ToolsPage() {
  return (
    <div className="set-page" id="pg-tools">
      <div className="set-tt">工具</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-tools"]} />
    </div>
  );
}
