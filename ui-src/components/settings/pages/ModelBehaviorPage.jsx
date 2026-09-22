import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function ModelBehaviorPage() {
  return (
    <div className="set-page" id="pg-model-behavior">
      <div className="set-tt">模型行为</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-model-behavior"]} />
    </div>
  );
}
