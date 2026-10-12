import { appendFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const resultFile = process.env.VAGUS_ELICITATION_RESULT_FILE;
let requestId = 0;
const pending = new Map();
const fields = {
  type: 'object',
  required: ['name', 'count', 'enabled', 'priority', 'labels'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'A short label', minLength: 2, maxLength: 20 },
    count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 },
    enabled: { type: 'boolean', title: 'Enabled' },
    priority: { type: 'string', title: 'Priority', oneOf: [{ const: 'low', title: 'Low' }, { const: 'high', title: 'High' }] },
    labels: { type: 'array', title: 'Labels', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['red', 'blue'] } },
  },
};

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function request(method, params) {
  const id = `elicitation-${++requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP elicitation request timed out')); }, 60_000);
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
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vagus-elicitation-smoke', version: '1.0.0' } } });
  } else if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    // MCP notifications do not receive a JSON-RPC response.
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ask_form', description: 'Request a Vagus structured form for ACP end-to-end validation.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
  } else if (message.method === 'tools/call' && message.params?.name === 'ask_form') {
    // Keep reading stdio while the nested elicitation request is pending; MCP
    // sends its response on the same stream and serially awaiting here deadlocks.
    void (async () => {
      try {
        const elicitation = await request('elicitation/create', { mode: 'form', message: 'Complete the local Vagus form round-trip check.', requestedSchema: fields });
        if (resultFile) await writeFile(resultFile, JSON.stringify(elicitation), 'utf8');
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `VAGUS_ELICITATION_RESULT:${JSON.stringify(elicitation)}` }] } });
      } catch (error) {
        if (resultFile) await appendFile(resultFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'utf8').catch(() => undefined);
        send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'VAGUS_ELICITATION_SMOKE_FAILED' }] } });
      }
    })();
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}
