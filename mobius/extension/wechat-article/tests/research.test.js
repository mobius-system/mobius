const test = require('node:test');
const assert = require('node:assert/strict');

const research = require('../backend/lib/research');

test('research fetch failure logs through worker logger object and continues', async () => {
  const originalFetch = global.fetch;
  const warnings = [];
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '{"queries":[]}' }], usage: {} }),
  });
  try {
    const result = await research.runResearch({
      topic: { title: '测试选题', angle: '事实解读', questions: '', referenceUrls: ['not-a-valid-url'] },
      db: null,
      provider: { baseUrl: 'https://model.example', authToken: 'test', model: 'test', label: 'test' },
      budgets: { per_article_search: 2 },
      logger: { warn: (message) => warnings.push(message), info() {}, error() {} },
    });
    assert.equal(result.evidence.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /抓取失败 not-a-valid-url: 非法 URL/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('research logger remains compatible with legacy function form', () => {
  const calls = [];
  research.writeLog((level, message) => calls.push({ level, message }), 'warn', 'legacy warning');
  assert.deepEqual(calls, [{ level: 'warn', message: 'legacy warning' }]);
});
