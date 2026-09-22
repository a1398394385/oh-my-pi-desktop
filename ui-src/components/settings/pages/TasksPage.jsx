import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function TasksPage() {
  return (
    <div className="set-page" id="pg-tasks">
      <div className="set-tt">任务·子代理</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-tasks"]} />
    </div>
  );
}
