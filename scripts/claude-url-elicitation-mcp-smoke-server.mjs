import { appendFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const resultFile = process.env.VAGUS_URL_ELICITATION_RESULT_FILE;
const traceFile = process.env.VAGUS_URL_ELICITATION_TRACE_FILE;
let requestId = 0;
const pending = new Map();
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function request(method, params) {
  const id = `url-elicitation-${++requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('URL elicitation request timed out')); }, 60_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (traceFile) await appendFile(traceFile, `${JSON.stringify(message)}\n`, 'utf8').catch(() => undefined);
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
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, elicitation: { url: {} } }, serverInfo: { name: 'vagus-url-elicitation-smoke', version: '1.0.0' } } });
  } else if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    // MCP notifications do not receive a JSON-RPC response.
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ask_url', description: 'Request a URL authorization consent card from Vagus.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
  } else if (message.method === 'tools/call' && message.params?.name === 'ask_url') {
    void (async () => {
      try {
        const elicitation = await request('elicitation/create', {
          mode: 'url',
          message: 'Authenticate with the local Vagus URL elicitation test service.',
          url: 'https://example.com/oauth/authorize?client_id=vagus-smoke&state=not-a-secret',
          elicitationId: 'vagus-url-elicitation-smoke-001',
        });
        if (resultFile) await writeFile(resultFile, JSON.stringify(elicitation), 'utf8');
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `VAGUS_URL_ELICITATION_RESULT:${JSON.stringify(elicitation)}` }] } });
      } catch (error) {
        if (resultFile) await writeFile(resultFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'utf8').catch(() => undefined);
        send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'VAGUS_URL_ELICITATION_SMOKE_FAILED' }] } });
      }
    })();
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}
