import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';

const resultFile = process.env.VAGUS_CANCEL_RESULT_FILE;
let requestId = 0;
const pending = new Map();
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function request(method, params) {
  const id = `cancel-smoke-${++requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out')); }, 60_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id !== undefined && !message.method) {
    const item = pending.get(String(message.id));
    if (item) {
      pending.delete(String(message.id));
      if (message.error) item.reject(new Error(message.error.message ?? 'MCP request failed'));
      else item.resolve(message.result);
    }
    continue;
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vagus-cancel-smoke', version: '1.0.0' } } });
  } else if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    // MCP notifications do not receive a response.
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'wait_for_cancel', description: 'A harmless long-running tool used only to verify cancellation.', inputSchema: { type: 'object', properties: { seconds: { type: 'integer', minimum: 5, maximum: 30 } }, required: ['seconds'], additionalProperties: false } }] } });
  } else if (message.method === 'tools/call' && message.params?.name === 'wait_for_cancel') {
    void (async () => {
      const seconds = Math.min(30, Math.max(5, Number(message.params.arguments?.seconds) || 20));
      if (resultFile) await writeFile(resultFile, JSON.stringify({ startedAt: new Date().toISOString(), seconds }), 'utf8').catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'WAIT_FOR_CANCEL_FINISHED' }] } });
    })();
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}
