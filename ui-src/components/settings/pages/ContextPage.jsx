import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function ContextPage() {
  return (
    <div className="set-page" id="pg-context">
      <div className="set-tt">上下文</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-context"]} />
    </div>
  );
}
