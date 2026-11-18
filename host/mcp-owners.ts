// Minted `mcp__<server>_<tool>` name → MCP server, held process-wide.
//
// Leaf on purpose: two consumers sit outside the mount registry — the
// provider-view rewrite (an unmounted tool's instance is gone by then) and the
// xd:// toast line (the base names every minted tool individually). A minted
// name encodes its server, so every session mounting the same server agrees;
// only two servers minting one name would clash, and the rewritten text still
// names a real server.
const toolServerOwners = new Map<string, string>();

/** Records ownership as a server's tools enter or leave a session's surface. */
export function rememberToolOwners(tools: readonly { name: string; mcpServerName: string }[]): void {
  for (const tool of tools) toolServerOwners.set(tool.name, tool.mcpServerName);
}

/** MCP server behind a minted `mcp__` tool name. */
export function mcpToolServer(toolName: string): string | undefined {
  return toolServerOwners.get(toolName);
}