const test = require('node:test');
const assert = require('node:assert/strict');

const humanize = require('../backend/lib/humanize');
const { NATURAL_WRITING_GUIDE } = require('../backend/lib/natural-style');

test('natural writing detector catches Chinese AI-style patterns and repetition', () => {
  const result = humanize.detect([
    '# 全面解析大模型',
    '在当今快速发展的时代，技术正在赋能产业。',
    '首先看产品，其次看价格，最后看渠道。',
    '研究表明，这一方案至关重要。',
    '用户需要明确目标。用户需要明确边界。用户需要明确风险。',
  ].join('\n'));
  assert.ok(result.hits.some((hit) => hit.label === '模板化标题'));
  assert.ok(result.hits.some((hit) => hit.label === '时代/背景套话'));
  assert.ok(result.hits.some((hit) => hit.label === '报幕式连接'));
  assert.ok(result.hits.some((hit) => hit.label === '无来源共识'));
  assert.ok(result.hits.some((hit) => hit.label === '重复句首'));
  assert.equal(result.stats.sentences, 7);
});

test('natural writing guide preserves the skill principles in model prompts', () => {
  assert.match(NATURAL_WRITING_GUIDE, /具体主语和动作动词/);
  assert.match(NATURAL_WRITING_GUIDE, /没有来源/);
  assert.match(NATURAL_WRITING_GUIDE, /连贯段落/);
});
