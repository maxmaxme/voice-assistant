export interface McpContentPart {
  type: string;
  text?: string;
}

/** Validate the `content` field returned by an MCP tool call. The MCP spec
 *  defines it as an array of typed parts (text / image / resource …); we
 *  only consume `text` parts but accept any `{ type: string, text?: string }`
 *  to stay forward-compatible. */
export function isValidContent(value: unknown): value is McpContentPart[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (const part of value) {
    if (part === null || typeof part !== 'object') {
      return false;
    }
    if (!('type' in part) || typeof part.type !== 'string') {
      return false;
    }
    if ('text' in part && part.text !== undefined && typeof part.text !== 'string') {
      return false;
    }
  }
  return true;
}
