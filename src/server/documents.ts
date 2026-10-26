// The wire's document: one tool result wrapping one `pi-agent-result/2`.
//
// `tools/call` always answers a tool result — a refusal is a successful call
// that ran nothing, never a JSON-RPC error (design sec-5) — so this is the one
// place the result document is framed for the wire.
import type { AgentResult } from './result.ts';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError: boolean };

export function toolResult(document: AgentResult): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(document) }],
    isError: document.state !== 'completed',
  };
}
