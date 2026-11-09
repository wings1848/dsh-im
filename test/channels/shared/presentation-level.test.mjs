import assert from 'node:assert/strict';
import test from 'node:test';

import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import {
  DEFAULT_PRESENTATION_LEVEL,
  PRESENTATION_LEVELS,
  createTurnProgress,
  normalizePresentationLevel,
  parsePresentationLevelInput,
  presentationLevelFromConfig,
  presentationLevelLabel,
  summarizeToolArguments,
} from '../../../src/channels/shared/presentation-level.mjs';

test('P1: three rungs, standard by default', () => {
  assert.deepEqual([...PRESENTATION_LEVELS], ['minimal', 'standard', 'full']);
  assert.equal(DEFAULT_PRESENTATION_LEVEL, 'standard');
  assert.equal(normalizePresentationLevel(undefined), 'standard');
  assert.equal(normalizePresentationLevel('FULL'), 'full');
  assert.equal(normalizePresentationLevel('  minimal  '), 'minimal');
  assert.equal(normalizePresentationLevel('verbose'), 'standard', 'an unknown stored value is not guessed');
  assert.equal(normalizePresentationLevel('nonsense', null), null, 'a null fallback lets callers detect "absent"');
});

test('P2: the legacy boolean keeps its meaning, absent now means standard', () => {
  // Explicit level wins over the legacy field.
  assert.equal(presentationLevelFromConfig({ presentationLevel: 'minimal', thinkingTraces: true }), 'minimal');
  // Legacy true was "show me everything": that reader keeps the full rung.
  assert.equal(presentationLevelFromConfig({ thinkingTraces: true }), 'full');
  // Legacy false was "one placeholder"; that is the standard rung.
  assert.equal(presentationLevelFromConfig({ thinkingTraces: false }), 'standard');
  // Absent used to mean ON (the per-line flood). That default is the bug this
  // setting exists to remove, so an absent field is compact now.
  assert.equal(presentationLevelFromConfig({}), 'standard');
  assert.equal(presentationLevelFromConfig(null), 'standard');
});

test('P3: /display accepts Chinese and English words, nothing else', () => {
  assert.equal(parsePresentationLevelInput('极简'), 'minimal');
  assert.equal(parsePresentationLevelInput('标准'), 'standard');
  assert.equal(parsePresentationLevelInput('全面'), 'full');
  assert.equal(parsePresentationLevelInput('MINIMAL'), 'minimal');
  assert.equal(parsePresentationLevelInput('verbose'), 'full');
  assert.equal(parsePresentationLevelInput('默认'), 'standard');
  assert.equal(parsePresentationLevelInput('loud'), null);
  assert.equal(parsePresentationLevelInput(''), null);
  assert.equal(parsePresentationLevelInput(undefined), null);
});

test('P4: level names are localized', (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  assert.equal(presentationLevelLabel('minimal'), '极简');
  assert.equal(presentationLevelLabel('standard'), '标准');
  assert.equal(presentationLevelLabel('full'), '全面');
  setImHostLanguage('en');
  assert.equal(presentationLevelLabel('standard'), 'Standard');
});

test('P5: tool arguments become one short phrase, never a payload', () => {
  assert.equal(summarizeToolArguments({ command: 'npm test' }), '{"command":"npm test"}');
  assert.equal(summarizeToolArguments('ls -la'), 'ls -la');
  assert.equal(summarizeToolArguments('a\nb\t c'), 'a b c');
  assert.equal(summarizeToolArguments(undefined), null);
  assert.equal(summarizeToolArguments(''), null);
  const long = summarizeToolArguments('x'.repeat(200));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('P6: the compact line counts steps and carries elapsed time', () => {
  let now = 1_000;
  const progress = createTurnProgress({ now: () => now, startedAt: 1_000 });
  assert.equal(progress.runningText(), '⏳ 处理中 · 0 秒');
  progress.tool('bash', { command: 'ls' });
  now += 12_000;
  assert.equal(progress.runningText(), '⏳ 处理中 · 12 秒 · 1 步\n🔧 bash → {"command":"ls"}');
  progress.settle({ ok: true });
  assert.equal(progress.runningText(), '⏳ 处理中 · 12 秒 · 1 步\n✅ bash → {"command":"ls"}');
  progress.tool('edit');
  progress.settle({ ok: false });
  assert.equal(
    progress.runningText(),
    '⏳ 处理中 · 12 秒 · 2 步\n⚠️ edit',
    'a failed latest step is marked, and a tool without arguments adds no arrow',
  );
  assert.equal(progress.doneText(), '✅ 完成 · 12 秒 · 2 步');
  assert.equal(progress.failedText(), '⚠️ 已中断 · 12 秒 · 2 步');
  assert.equal(progress.steps, 2);
});

test('P7: a turn with no tool calls omits the step count', () => {
  const progress = createTurnProgress({ now: () => 6_000, startedAt: 1_000 });
  assert.equal(progress.doneText(), '✅ 完成 · 5 秒');
  assert.equal(progress.failedText(), '⚠️ 已中断 · 5 秒');
});

test('P8: the compact line is translated in English', (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('en');
  const progress = createTurnProgress({ now: () => 3_000, startedAt: 1_000 });
  progress.tool('bash', 'ls');
  assert.equal(progress.runningText(), '⏳ Working · 2s · 1 steps\n🔧 bash → ls');
  assert.equal(progress.doneText(), '✅ Done · 2s · 1 steps');
});
