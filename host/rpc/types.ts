// RPC handler signature: ws is a Bun WS, msg is the JSON.parse'd request body (any, narrowed field-by-field at the boundary).
// Exceptions are caught uniformly by the main.ts dispatch shell and replied as error frames; handlers mind business only.
export type RpcHandler = (ws: any, msg: any) => void | Promise<void>;
