import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-config-options-'));
const provider = new ClaudeProvider();
let session;
let initialSettings;

function choices(option) {
  return option?.type === 'select' ? option.options.flatMap(item => 'options' in item ? item.options : [item]) : [];
}

try {
  session = await provider.startSession({ sessionId: `claude-config-options-${randomUUID()}`, workingDirectory: root }, () => undefined);
  const configOptions = session.configOptions ?? [];
  initialSettings = await session.getRuntimeSettings?.();
  const modelOption = configOptions.find(option => option.category === 'model');
  const effortOption = configOptions.find(option => option.category === 'thought_level');
  const modelChecks = [];
  for (const choice of choices(modelOption)) {
    const settings = await session.setModel?.(choice.value);
    modelChecks.push({ value: choice.value, returned: settings?.modelId ?? null, passed: settings?.modelId === choice.value });
  }
  const effortChecks = [];
  for (const choice of choices(effortOption)) {
    const settings = await session.setThinkingLevel?.(choice.value);
    effortChecks.push({ value: choice.value, returned: settings?.thinkingLevel ?? null, passed: settings?.thinkingLevel === choice.value });
  }
  const modeChecks = [];
  for (const mode of initialSettings?.availableModes ?? []) {
    const settings = await session.setMode?.(mode.id);
    modeChecks.push({ id: mode.id, returned: settings?.currentModeId ?? null, passed: settings?.currentModeId === mode.id });
  }
  const restoreChecks = [];
  if (initialSettings?.modelId) {
    const restored = await session.setModel?.(initialSettings.modelId);
    restoreChecks.push({ key: 'modelId', passed: restored?.modelId === initialSettings.modelId });
  }
  if (initialSettings?.thinkingLevel) {
    const restored = await session.setThinkingLevel?.(initialSettings.thinkingLevel);
    restoreChecks.push({ key: 'thinkingLevel', passed: restored?.thinkingLevel === initialSettings.thinkingLevel });
  }
  if (initialSettings?.currentModeId) {
    const restored = await session.setMode?.(initialSettings.currentModeId);
    restoreChecks.push({ key: 'currentModeId', passed: restored?.currentModeId === initialSettings.currentModeId });
  }
  const options = configOptions.map(option => ({
    id: option.id,
    name: option.name,
    category: option.category ?? null,
    type: option.type,
    description: option.description ?? null,
    currentValue: option.currentValue,
    choices: option.type === 'select' ? option.options.flatMap(group => 'options' in group ? [{ group: group.name, values: group.options.map(item => ({ value: item.value, name: item.name, description: item.description ?? null })) }] : [{ group: null, values: [{ value: group.value, name: group.name, description: group.description ?? null }] }]) : undefined,
  }));
  const allSettingsPassed = [...modelChecks, ...effortChecks, ...modeChecks, ...restoreChecks].every(check => check.passed);
  console.log(JSON.stringify({ optionCount: options.length, options, modelChecks, effortChecks, modeChecks, restoreChecks, allSettingsPassed, runtimeSettings: await session.getRuntimeSettings?.() }, null, 2));
  if (!allSettingsPassed) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 2;
} finally {
  const reference = session?.storageReference;
  if (initialSettings && session) {
    if (initialSettings.modelId) await session.setModel?.(initialSettings.modelId).catch(() => undefined);
    if (initialSettings.thinkingLevel) await session.setThinkingLevel?.(initialSettings.thinkingLevel).catch(() => undefined);
    if (initialSettings.currentModeId) await session.setMode?.(initialSettings.currentModeId).catch(() => undefined);
  }
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(error => console.error('Native session cleanup:', error instanceof Error ? error.message : String(error)));
  if (!resolve(root).startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
