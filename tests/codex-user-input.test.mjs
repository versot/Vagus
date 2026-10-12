import assert from 'node:assert/strict';
import test from 'node:test';
import { codexInteractionCancellationResponse, mapCodexElicitationRequest, mapCodexElicitationResponse, mapCodexUserInputAnswers, mapCodexUserInputQuestions } from "../packages/host/dist/agent/providers/codex/interactions.js";

test('maps Codex multi-question choice and text prompts to a Vagus form', () => {
  const mapped = mapCodexUserInputQuestions([
    { id: 'format', header: 'Format', question: 'Choose an output format', isSecret: false, isOther: false, options: [{ label: 'Markdown', description: 'Readable text' }, { label: 'JSON', description: 'Structured data' }] },
    { id: 'audience', header: 'Audience', question: 'Who will read this?', isSecret: false, isOther: false, options: null },
  ]);

  assert.equal(mapped.interaction.kind, 'form');
  assert.deepEqual(mapped.interaction.fields.map(({ id, type, required }) => ({ id, type, required })), [
    { id: 'format', type: 'choice', required: true },
    { id: 'audience', type: 'text', required: true },
  ]);
  assert.deepEqual(mapped.interaction.fields[0].options, [
    { value: 'Markdown', label: 'Markdown', description: 'Readable text' },
    { value: 'JSON', label: 'JSON', description: 'Structured data' },
  ]);
  assert.deepEqual(mapped.mappings, [{ questionId: 'format' }, { questionId: 'audience' }]);
});

test('maps Codex other answers through an optional Vagus text field', () => {
  const mapped = mapCodexUserInputQuestions([
    { id: 'first', header: 'First', question: 'Pick one', isSecret: false, isOther: true, options: [{ label: 'A', description: '' }] },
    { id: 'second', header: 'Second', question: 'Pick another', isSecret: false, isOther: false, options: [{ label: 'B', description: '' }] },
  ]);

  assert.equal(mapped.interaction.fields[0].options.at(-1).value, '__vagus_other__');
  assert.equal(mapped.interaction.fields[1].id, 'first__vagus_other');
  assert.equal(mapped.interaction.fields[1].required, false);
  assert.deepEqual(mapCodexUserInputAnswers(JSON.stringify({ first: '__vagus_other__', first__vagus_other: 'Custom answer', second: 'B' }), mapped.mappings), {
    answers: { first: { answers: ['Custom answer'] }, second: { answers: ['B'] } },
  });
});

test('maps a single Codex question with an other option to a Vagus form', () => {
  const mapped = mapCodexUserInputQuestions([
    { id: 'choice', header: 'Choice', question: 'Pick one', isSecret: false, isOther: true, options: [{ label: 'A', description: '' }] },
  ]);
  assert.equal(mapped.interaction.kind, 'form');
  assert.equal(mapped.interaction.fields.length, 2);
  assert.equal(mapped.interaction.fields[0].options.at(-1).value, '__vagus_other__');
  assert.deepEqual(mapCodexUserInputAnswers(JSON.stringify({ choice: '__vagus_other__', choice__vagus_other: 'Custom' }), mapped.mappings), { answers: { choice: { answers: ['Custom'] } } });
});

test('returns unanswered values when optional free-text answers are blank or malformed', () => {
  const mappings = [{ questionId: 'a' }, { questionId: 'b' }];
  assert.deepEqual(mapCodexUserInputAnswers('{"a":"yes","b":""}', mappings), { answers: { a: { answers: ['yes'] }, b: { answers: [] } } });
  assert.deepEqual(mapCodexUserInputAnswers('not-json', mappings), { answers: { a: { answers: [] }, b: { answers: [] } } });
});

test('does not map malformed or secret Codex questions into visible Vagus form fields', () => {
  assert.equal(mapCodexUserInputQuestions([
    { id: 'a', header: 'A', question: 'A?', isSecret: false, isOther: false, options: null },
    { id: 'b', header: 'B', question: 'B?', isSecret: true, isOther: false, options: null },
  ]), null);
  assert.equal(mapCodexUserInputQuestions([
    { id: 'a', header: 'A', question: 'A?', isSecret: false, isOther: false, options: null },
    { header: 'Missing id', question: 'No id', isSecret: false, isOther: false, options: null },
  ]), null);
  assert.equal(mapCodexUserInputQuestions([
    { id: 'same', header: 'A', question: 'A?', isSecret: false, isOther: false, options: null },
    { id: 'same', header: 'B', question: 'B?', isSecret: false, isOther: false, options: null },
  ]), null);
});

test('maps Codex MCP elicitation form fields and choices to native Vagus fields', () => {
  const mapped = mapCodexElicitationRequest({
    mode: 'form', serverName: 'demo-mcp', message: 'Configure the report',
    requestedSchema: {
      type: 'object', required: ['format', 'includeCharts'],
      properties: {
        format: { type: 'string', title: 'Format', oneOf: [{ const: 'md', title: 'Markdown' }, { const: 'json', title: 'JSON' }], default: 'md' },
        includeCharts: { type: 'boolean', title: 'Include charts', default: true },
        count: { type: 'integer', title: 'Count', minimum: 1, maximum: 20, default: 3 },
        tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
      },
    },
  });

  assert.equal(mapped.interaction.kind, 'form');
  assert.equal(mapped.interaction.title, 'demo-mcp 请求输入');
  assert.deepEqual(mapped.interaction.fields.map(({ id, type, required }) => ({ id, type, required })), [
    { id: 'format', type: 'choice', required: true },
    { id: 'includeCharts', type: 'boolean', required: true },
    { id: 'count', type: 'number', required: false },
    { id: 'tags', type: 'multi-choice', required: false },
  ]);
  assert.deepEqual(mapped.interaction.fields[0].options, [{ value: 'md', label: 'Markdown' }, { value: 'json', label: 'JSON' }]);
  assert.deepEqual(mapped.interaction.fields[3].options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
});

test('maps Codex URL consent requests but rejects unsafe links and unsupported schemas', () => {
  const mapped = mapCodexElicitationRequest({ mode: 'url', serverName: 'search', message: 'Sign in', url: 'https://example.com/auth', elicitationId: '1' });
  assert.deepEqual(mapped.interaction, { kind: 'url-consent', title: 'search 请求打开链接', message: 'Sign in', url: 'https://example.com/auth', host: 'example.com' });
  assert.equal(mapCodexElicitationRequest({ mode: 'url', serverName: 'bad', message: 'Open', url: 'file:///etc/passwd' }), null);
  assert.equal(mapCodexElicitationRequest({ mode: 'form', serverName: 'nested', message: 'Input', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } }), null);
  assert.equal(mapCodexElicitationRequest({ mode: 'form', serverName: 'empty', message: 'Input', requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: [] } } } }), null);
});

test('maps Codex MCP tool approval elicitations with scoped allow choices and visible tool arguments', () => {
  const mapped = mapCodexElicitationRequest({
    mode: 'form', serverName: 'filesystem', message: 'Allow this tool call?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'],
      tool_name: 'write_file', tool_description: 'Write a file to disk.',
      tool_params: { path: 'notes.txt', content: 'hello' },
      tool_params_display: [{ name: 'path', value: 'notes.txt' }],
    },
  });

  assert.equal(mapped.interaction.kind, 'choice');
  assert.deepEqual(mapped.interaction.options, ['允许本次', '本会话允许', '始终允许', '拒绝']);
  assert.match(mapped.interaction.message, /filesystem.*write_file/u);
  assert.match(mapped.interaction.message, /Write a file to disk/u);
  assert.match(mapped.interaction.message, /notes\.txt/u);
  assert.deepEqual(mapped.approvalPersistence, { '本会话允许': 'session', '始终允许': 'always' });
  assert.deepEqual(mapCodexElicitationResponse('允许本次', 'form', mapped.labels, mapped.approvalPersistence), { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(mapCodexElicitationResponse('本会话允许', 'form', mapped.labels, mapped.approvalPersistence), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(mapCodexElicitationResponse('始终允许', 'form', mapped.labels, mapped.approvalPersistence), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(mapCodexElicitationResponse('拒绝', 'form', mapped.labels, mapped.approvalPersistence), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(mapCodexElicitationResponse(null, 'form', mapped.labels, mapped.approvalPersistence), { action: 'cancel', content: null, _meta: null });
});

test('offers only Codex MCP approval persistence scopes advertised by the request', () => {
  const mapped = mapCodexElicitationRequest({
    mode: 'form', serverName: 'demo', message: 'Run this?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session', tool_title: 'read_file', tool_params: { path: 'README.md' } },
  });
  assert.deepEqual(mapped.interaction.options, ['允许本次', '本会话允许', '拒绝']);
  assert.deepEqual(mapped.approvalPersistence, { '本会话允许': 'session' });
  assert.equal(mapCodexElicitationRequest({ mode: 'form', message: 'Empty ordinary form', requestedSchema: { type: 'object', properties: {} } }), null);
});

test('serializes Codex MCP elicitation accept, decline, and cancel responses', () => {
  assert.deepEqual(mapCodexElicitationResponse('{"name":"Ada"}', 'form', []), { action: 'accept', content: { name: 'Ada' }, _meta: null });
  assert.deepEqual(mapCodexElicitationResponse('bad-json', 'form', []), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(mapCodexElicitationResponse('取消', 'url', ['打开链接']), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(mapCodexElicitationResponse(null, 'url', ['打开链接']), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(mapCodexElicitationResponse('打开链接', 'url', ['打开链接']), { action: 'accept', content: null, _meta: null });
});

test('cancels each Codex interaction with the response shape required by its protocol method', () => {
  assert.deepEqual(codexInteractionCancellationResponse({ method: 'mcpServer/elicitation/request', elicitationMode: 'url', labels: ['Open'] }), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(codexInteractionCancellationResponse({ method: 'item/tool/requestUserInput', questionMappings: [{ questionId: 'q1' }, { questionId: 'q2' }], labels: [] }), { answers: { q1: { answers: [] }, q2: { answers: [] } } });
  assert.deepEqual(codexInteractionCancellationResponse({ method: 'item/permissions/requestApproval', labels: [] }), { permissions: {}, scope: 'turn' });
  assert.deepEqual(codexInteractionCancellationResponse({ method: 'item/commandExecution/requestApproval', labels: ['Allow'] }), { decision: 'cancel' });
});
