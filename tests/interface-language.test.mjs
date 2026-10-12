import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstance } from 'i18next';
import { chineseResources, englishResources } from '../packages/app/src/locales/en-US.ts';

test('Chinese covers the complete English resource set, including feature strings and plurals', () => {
  for (const key of Object.keys(englishResources)) {
    assert.equal(chineseResources[key], key.replace(/_(one|other)$/, ''), `Missing Chinese resource: ${key}`);
  }
});

test('scheduled-task labels stay Chinese and switch languages without English fallback', async () => {
  const instance = createInstance();
  await instance.init({
    lng: 'zh-CN', fallbackLng: 'en-US', keySeparator: false,
    resources: { 'zh-CN': { translation: chineseResources }, 'en-US': { translation: englishResources } },
    interpolation: { escapeValue: false },
  });
  for (const key of ['新建定时任务', '任务内容', '工作空间', '重复', '每天', '时间', '上海', '框架', '模型', '先选择 Agent 框架', '请先选择框架', '创建任务', '你的计划']) {
    assert.equal(instance.t(key), key);
  }
  assert.equal(instance.t('计划时间：{{time}} · {{zone}}', { time: '09:00', zone: '上海 UTC+8' }), '计划时间：09:00 · 上海 UTC+8');
  assert.equal(instance.t('{{count}} 个聊天', { count: 2 }), '2 个聊天');
  await instance.changeLanguage('en-US');
  assert.equal(instance.t('新建定时任务'), 'New scheduled task');
  await instance.changeLanguage('zh-CN');
  assert.equal(instance.t('新建定时任务'), '新建定时任务');
});
