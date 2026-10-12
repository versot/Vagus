import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCliNoticeFilter } from "../packages/host/dist/agent/providers/claude/gateway-notice.js";

const warning = "**Warning:** We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through coding.dashscope.aliyuncs.com, which isn't compatible with this update. Nothing breaks: auto mode keeps working, and its classifier requests are billed as before. To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing";

test('Claude Code gateway compatibility banner is separated from assistant output', () => {
  const filter = new ClaudeCliNoticeFilter();
  const result = filter.push(`VAGUS_WARNING_PROBE_OK${warning}`);
  assert.equal(result.text, 'VAGUS_WARNING_PROBE_OK');
  assert.equal(result.notice, warning);
  assert.deepEqual(filter.flush(), { text: '' });
});

test('Claude Code gateway warning is detected when ACP chunks split it at arbitrary boundaries', () => {
  const filter = new ClaudeCliNoticeFilter();
  const stream = `answer${warning}`;
  let text = '';
  let notice;
  for (let index = 0; index < stream.length; index += 7) {
    const result = filter.push(stream.slice(index, index + 7));
    text += result.text;
    notice ??= result.notice;
  }
  text += filter.flush().text;
  assert.equal(text, 'answer');
  assert.equal(notice, warning);
});

test('ordinary assistant text and an incomplete warning-like prefix are preserved', () => {
  const filter = new ClaudeCliNoticeFilter();
  const response = 'The warning text is quoted: **Warning:** We are changing behavior.';
  const result = filter.push(response);
  assert.equal(result.notice, undefined);
  assert.equal(result.text + filter.flush().text, response);
});
