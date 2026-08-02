const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/main.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/app.css'), 'utf8');

test('hotspot UI uses extension actions and preserves manual writing path', () => {
  for (const action of ['start_collect', 'collect_status', 'stop_collect', 'list_hotspots', 'create_topic_from_hotspot']) {
    assert.match(source, new RegExp(`api\\("${action}"`));
  }
  assert.match(source, /从热点开始/);
  assert.match(source, /自定义主题/);
  assert.match(source, /topic_id: state\.selectedTopic/);
});

test('hotspot workspace has responsive list/detail styling', () => {
  assert.match(css, /\.hotspot-workspace/);
  assert.match(css, /\.hotspot-detail/);
  assert.match(css, /@media \(max-width: 980px\)/);
});

test('hotspot UI explains multiple candidates and relevance levels', () => {
  assert.match(source, /近时段候选/);
  assert.match(source, /直接命中/);
  assert.match(source, /扩展候选/);
  assert.match(source, /与检索方向相关度/);
  for (const kind of ['high', 'extended', 'current']) assert.match(css, new RegExp(`\\.hotspot-tags span\\.relevance-${kind}`));
});
