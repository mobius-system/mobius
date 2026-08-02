const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const extensionRoot = path.join(__dirname, '../extension/wechat-article');
const jobStore = require(path.join(extensionRoot, 'backend/lib/job-store'));
const llm = require(path.join(extensionRoot, 'backend/lib/llm'));

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-article-job-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function testJobListKeepsTopicTitleAndActiveState() {
  withTempDir((dir) => {
    const jobId = jobStore.createJob(dir, {
      kind: 'article',
      spec: { topic: { title: '后台文章任务' }, mode: 'manual', modelKey: 'model:test' },
    });
    jobStore.writePid(dir, jobId, process.pid);
    const jobs = jobStore.listJobs(dir, 10);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].jobId, jobId);
    assert.strictEqual(jobs[0].state, 'queued');
    assert.strictEqual(jobs[0].title, '后台文章任务');
  });
}

async function testTransientModelFailureRetries() {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('fetch failed');
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
    };
  };
  try {
    const result = await llm.callModel({
      provider: { baseUrl: 'https://example.com', authToken: 'token', model: 'test', label: 'test' },
      system: 'system', user: 'user', retries: 1, retryDelayMs: 1, timeoutMs: 1000,
    });
    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(calls, 2, 'transient model errors should retry once in background work');
  } finally { global.fetch = previousFetch; }
}

function testTimeoutErrorIsReadable() {
  const error = llm.normalizeModelError({ name: 'AbortError' }, 30_000);
  assert.strictEqual(error.code, 'MODEL_TIMEOUT');
  assert.match(error.message, /模型响应超时/);
  assert(llm.isTransientModelError(error));
}

function testFrontendRestoresBackgroundJob() {
  const source = fs.readFileSync(path.join(extensionRoot, 'frontend/main.js'), 'utf8');
  assert(source.includes('wechat-article-active-job'), 'frontend should persist the active job id');
  assert(source.includes('api("list_jobs"'), 'frontend should discover server-side jobs after reopening');
  assert(source.includes('runJobPoll(state.activeJob.jobId, { resumed: true })'), 'frontend should resume polling after bootstrap');
  assert(source.includes('任务正在服务器后台运行'), 'frontend should explain that leaving the page is safe');
  assert(!/beforeunload[\s\S]{0,300}cancel_job/.test(source), 'page unload must never cancel a background article job');
}

function testWorkerIsDetachedAndNonCriticalReviewDegradesGracefully() {
  const handler = fs.readFileSync(path.join(extensionRoot, 'backend/extension_backend_handler.js'), 'utf8');
  const worker = fs.readFileSync(path.join(extensionRoot, 'backend/article-worker.js'), 'utf8');
  assert(handler.includes('detached: true'), 'article worker must be detached from the extension request lifecycle');
  assert(handler.includes('child.unref()'), 'detached worker must not keep the handler alive');
  assert(worker.includes('去 AI 味阶段超时或失败，保留原稿继续'), 'humanize timeout should preserve the generated draft');
  assert(worker.includes('主张账本绑定失败，降级为空账本继续'), 'claim binding timeout should not discard the draft');
}

async function main() {
  testJobListKeepsTopicTitleAndActiveState();
  await testTransientModelFailureRetries();
  testTimeoutErrorIsReadable();
  testFrontendRestoresBackgroundJob();
  testWorkerIsDetachedAndNonCriticalReviewDegradesGracefully();
  console.log('wechat-article background job tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
