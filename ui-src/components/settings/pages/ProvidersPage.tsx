import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function ProvidersPage() {
  return (
    <div className="set-page" id="pg-providers">
      <div className="set-tt">服务商</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-providers"]} />
    </div>
  );
}
