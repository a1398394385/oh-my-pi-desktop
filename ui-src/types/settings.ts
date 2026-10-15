// Shape of a single schema key definition (aligned with SETTINGS_SCHEMA; ui metadata optional).
// Both ui and def allow unlisted extra fields so new base keys don't error here.
export interface SchemaUi {
  tab?: string;
  group?: string;
  label?: string;
  description?: string;
  warning?: string;
  options?: Array<{ value: string | number; label?: string }> | "runtime";
  condition?: string;
  [key: string]: unknown;
}

export interface SchemaDef {
  type: string;
  credential?: boolean;
  default?: unknown;
  values?: string[];
  ui?: SchemaUi;
  [key: string]: unknown;
}

