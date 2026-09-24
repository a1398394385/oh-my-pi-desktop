import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function TasksPage() {
  return (
    <div className="set-page" id="pg-tasks">
      <div className="set-tt">任务·子代理</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-tasks"]} />
    </div>
  );
}
