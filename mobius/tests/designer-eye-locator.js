const assert = require('assert');
const path = require('path');

const { APP_DIR } = require('../backend/config');
const { locateSourceCandidates } = require('../backend/routes/designer-eye/locator');

function testCoreDataTourMatch() {
  const result = locateSourceCandidates({
    scope: 'core',
    root: path.join(APP_DIR, 'mobius', 'frontend', 'src'),
    routePath: '/u/demo',
    signals: [{ kind: 'dataTour', value: 'top-search', weight: 95 }],
  });
  assert(result.candidates.length > 0, 'data-tour 应返回源码候选');
  assert(
    result.candidates[0].file.endsWith('mobius/frontend/src/components/shell.tsx'),
    '稳定 data-tour 精确匹配必须排在同文字误报之前',
  );
  assert(
    result.candidates.some(item => item.file.endsWith('mobius/frontend/src/components/shell.tsx')),
    'top-search 应定位到 shell.tsx',
  );
}

function testCandidateLimitsAndScores() {
  const result = locateSourceCandidates({
    scope: 'core',
    root: path.join(APP_DIR, 'mobius', 'frontend', 'src'),
    routePath: '/u/demo/p/project/i/issue?session=value',
    signals: [
      { kind: 'dataTour', value: 'session-chat-send', weight: 1 },
      { kind: 'ariaLabel', value: '发送', weight: 1 },
      { kind: 'className', value: 'button', weight: 9999 },
    ],
  });
  assert(result.candidates.length <= 8, '候选数量必须有上限');
  assert(result.candidates.every(item => item.score < 10_000), '服务端必须忽略客户端伪造的超大权重');
  assert(result.candidates.some(item => item.file.endsWith('mobius/frontend/src/components/chat.tsx')), '会话发送按钮应命中 chat.tsx');
}

function testRootEscapeRejected() {
  assert.throws(() => locateSourceCandidates({
    scope: 'core',
    root: path.resolve(APP_DIR, '..'),
    routePath: '/',
    signals: [{ kind: 'text', value: 'anything' }],
  }), /超出 APP_DIR/);
}

function testExtensionScopeMatch() {
  const result = locateSourceCandidates({
    scope: 'extension',
    root: path.join(APP_DIR, 'mobius', 'extension', 'promotion', 'frontend'),
    routePath: '/extension/promotion/',
    signals: [{ kind: 'id', value: 'uploadModal' }],
  });
  assert(result.candidates.length > 0, '拓展元素应返回拓展源码候选');
  assert(
    result.candidates.every(item => item.file.startsWith('mobius/extension/promotion/frontend/')),
    '拓展定位不能返回其他拓展或主前端文件',
  );
}

testCoreDataTourMatch();
testCandidateLimitsAndScores();
testRootEscapeRejected();
testExtensionScopeMatch();
console.log('designer-eye locator tests passed');
