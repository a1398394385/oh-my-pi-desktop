import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function InteractionPage() {
  return (
    <div className="set-page" id="pg-interaction">
      <div className="set-tt">交互</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-interaction"]} />
    </div>
  );
}
