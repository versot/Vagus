import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsFromAcpOptions } from "../packages/host/dist/agent/providers/acp/settings.js";

test('ACP mode config options become selectable session modes with descriptions', () => {
  const settings = settingsFromAcpOptions('opencode', [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opencode/longcat', options: [{ value: 'opencode/longcat', name: 'LongCat Free' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
    { id: 'mode', name: 'Agent', category: 'mode', type: 'select', currentValue: 'build', options: [
      { value: 'build', name: 'Build', description: 'Can use configured tools.' },
      { value: 'plan', name: 'Plan', description: 'Read-only planning.' },
    ] },
  ]);

  assert.equal(settings.currentModeId, 'build');
  assert.deepEqual(settings.availableModes, [
    { id: 'build', name: 'Build', description: 'Can use configured tools.' },
    { id: 'plan', name: 'Plan', description: 'Read-only planning.' },
  ]);
});

test('ACP grouped mode config options are flattened without dropping the selected mode', () => {
  const settings = settingsFromAcpOptions('opencode', [{
    id: 'mode', name: 'Agent', category: 'mode', type: 'select', currentValue: 'plan', options: [
      { group: 'primary', name: 'Primary agents', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
    ],
  }]);

  assert.equal(settings.currentModeId, 'plan');
  assert.deepEqual(settings.availableModes.map(({ id }) => id), ['build', 'plan']);
});

test('a full ACP config update that removes modes does not retain stale choices', () => {
  const previous = { providerId: 'opencode', modelId: 'opencode/longcat', thinkingLevel: null, thinkingLevels: [], currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }] };
  const settings = settingsFromAcpOptions('opencode', [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opencode/longcat', options: [{ value: 'opencode/longcat', name: 'LongCat Free' }] }], null, previous);

  assert.equal(settings.currentModeId, undefined);
  assert.equal(settings.availableModes, undefined);
});
