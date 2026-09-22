import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function FilesPage() {
  return (
    <div className="set-page" id="pg-files">
      <div className="set-tt">文件</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-files"]} />
    </div>
  );
}
