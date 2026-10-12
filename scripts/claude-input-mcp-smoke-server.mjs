import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';

const resultFile = process.env.VAGUS_INPUT_MCP_RESULT_FILE;
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vagus-input-smoke', version: '1.0.0' } } });
  } else if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    // MCP notifications do not receive a response.
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: 'echo_arguments',
      description: 'Return the exact arguments supplied by a Vagus live input smoke test.',
      inputSchema: { type: 'object', properties: { phrase: { type: 'string' }, count: { type: 'integer' } }, required: ['phrase', 'count'], additionalProperties: false },
    }] } });
  } else if (message.method === 'tools/call' && message.params?.name === 'echo_arguments') {
    const args = message.params.arguments ?? {};
    if (resultFile) await writeFile(resultFile, JSON.stringify(args), 'utf8');
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `ECHO_ARGUMENTS:${JSON.stringify(args)}` }] } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}
