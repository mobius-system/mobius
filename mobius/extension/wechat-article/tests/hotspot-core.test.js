const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../backend/lib/hotspot-core');
const store = require('../backend/lib/store');
const hotspotStore = require('../backend/lib/hotspot-store');

test('RSS/Atom items keep source trust and reported time', () => {
  const source = core.DEFAULT_SOURCES.find((x) => x.kind === 'official');
  const date = new Date().toUTCString();
  const xml = `<rss><channel><item><title><![CDATA[OpenAI 发布 Agent 工具]]></title><link>https://openai.com/news/agent?utm_source=x</link><pubDate>${date}</pubDate><description>官方发布新的 Agent 能力</description></item></channel></rss>`;
  const rows = core.parseFeed(xml, source);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].official, 1);
  assert.equal(rows[0].date_confidence, 'reported');
  assert.equal(rows[0].language, 'zh');
});

test('deterministic fallback merges strongly related same-language reports', () => {
  const base = { published_at: new Date().toISOString(), language: 'zh' };
  const groups = core.deterministicGroups([
    { ...base, id: 'a', title: 'OpenAI 发布 Agent 工具调用新能力', summary: '新的 Agent 工具调用与自动化能力' },
    { ...base, id: 'b', title: 'OpenAI Agent 工具调用能力正式发布', summary: 'Agent 可调用工具完成自动化任务' },
    { ...base, id: 'c', title: '英伟达发布新一代 GPU 芯片', summary: '面向数据中心的 GPU 算力与显存升级' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.some((g) => g.items.length === 2), true);
});

test('query relevance favors direct and adjacent technical matches', () => {
  const query = '大语言模型 OPD 相关训练';
  const direct = core.queryRelevanceScore('大语言模型 OPD 训练方法与实验结果公开', query);
  const adjacent = core.queryRelevanceScore('研究团队提出大语言模型训练新方法，优化偏好数据与推理能力', query);
  const unrelated = core.queryRelevanceScore('英伟达发布面向数据中心的新一代 GPU 芯片', query);
  assert.ok(direct >= 90);
  assert.ok(adjacent >= 35);
  assert.ok(unrelated < 35);
});

test('query search keeps multiple candidates when only one item is a direct match', async () => {
  const now = new Date().toISOString();
  const topics = [
    ['direct', '大语言模型 OPD 训练方法公布', '团队公开 OPD 训练流程与实验结果'],
    ['reasoning', '推理模型训练加入新的奖励机制', '研究者比较强化学习与偏好优化方法'],
    ['opensource', '开源模型发布训练数据配方', '项目披露预训练和后训练数据构成'],
    ['benchmark', '新基准评估长上下文模型能力', '论文比较多种模型架构和评测方案'],
    ['agent', 'Agent 工具调用框架发布新版本', '智能体可以执行更复杂的工作流'],
    ['multimodal', '多模态模型升级图像理解能力', '视觉语言模型加入新的对齐方法'],
    ['coding', 'AI 编程助手推出代码审查功能', '面向开发者提供仓库级代码分析'],
    ['robot', '机器人团队发布具身智能数据集', '数据集覆盖操作任务和仿真训练'],
    ['chip', 'AI 芯片厂商公布新一代加速卡', '产品面向大规模推理和训练集群'],
    ['policy', '人工智能治理框架发布更新', '监管机构说明模型透明度要求'],
  ];
  const items = topics.map(([id, title, summary], index) => ({
    id, title, summary, published_at: now, fetched_at: now, source_id: `source_${index}`,
    url: `https://example.com/${id}`, official: 0, date_confidence: 'reported', language: 'zh',
    metadata: { source_name: `来源 ${index + 1}`, tier: 'B', kind: 'media', region: 'all' },
  }));
  const clusters = await core.clusterAndScore(items, {
    searchId: 'search_multi', windowHours: 72, query: '大语言模型 OPD 相关训练',
    profile: {}, categories: [], provider: null,
  });
  assert.ok(clusters.length >= 8);
  assert.equal(clusters[0].status_tags[0], '高度相关');
  assert.ok(clusters.slice(1).some((cluster) => ['扩展相关', '同期热点'].includes(cluster.status_tags[0])));
  assert.ok(clusters[0].query_relevance >= clusters[1].query_relevance);
});

test('hotspot persistence creates traceable topic prefill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-hotspot-test-'));
  const db = store.open(dir);
  try {
    hotspotStore.seedSources(db, core.DEFAULT_SOURCES);
    const search = hotspotStore.createSearch(db, { query: 'Agent', window_hours: 72, region: 'all', categories: [] });
    const source = core.DEFAULT_SOURCES[0];
    const item = {
      id: 'hi_test', source_id: source.id, title: 'OpenAI 发布 Agent 新能力', url: 'https://openai.com/news/agent',
      summary: '官方发布新的 Agent 工具调用能力', published_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
      content_hash: 'hash_test', raw_excerpt: '官方发布', language: 'zh', official: 1, date_confidence: 'reported',
      metadata: { source_name: source.name, tier: source.tier, kind: source.kind, region: source.region },
    };
    hotspotStore.upsertItems(db, [item]);
    const clusters = await core.clusterAndScore([item], { searchId: search.id, windowHours: 72, query: 'Agent', profile: {}, categories: [], provider: null });
    hotspotStore.replaceClusters(db, search.id, clusters);
    hotspotStore.updateSearch(db, search.id, { status: 'done', coverage: { attempted: 1, succeeded: 1 }, result_count: 1, completed_at: new Date().toISOString() });
    const listed = hotspotStore.listHotspots(db, { searchId: search.id });
    assert.equal(listed.hotspots.length, 1);
    assert.equal(listed.hotspots[0].risk, 'official_confirmed');
    const topic = hotspotStore.createTopic(db, listed.hotspots[0], {}, { audience: 'AI 开发者' });
    assert.equal(topic.prefill.audience, 'AI 开发者');
    assert.deepEqual(topic.prefill.referenceUrls, ['https://openai.com/news/agent']);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
