/*
 * session-transfer-images.js — 转接文档屏蔽内嵌图片/超长记录的回归测试。
 * 背景: codex rollout 会把 aimux 工具结果里的整张 PNG 以 base64 内嵌
 * (单会话实测 1.4GB, 98.9% 是图片), 转接时 readFileSync 整文件读成字符串
 * 直接撞 V8 上限 "Cannot create a string longer than 0x1fffffe8 characters"。
 * 回归: transfer bundle must complete, images must be blocked.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 转接文档从会话历史库构建, 服务模块加载时读取该 env — 必须在 require 之前
// 指向临时库, 否则会连到真实 11GB 生产库。
// The digest builds from the history store; point the store at a temp dir
// BEFORE requiring the service modules (STORE_PATH is captured at load).
process.env.MOBIUS_AGENT_HISTORY_STORE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'session-transfer-images-store-')),
  'agent-history-store.db',
);

const { writeSessionTransferBundle, buildSessionTransferMarkdown } = require('../backend/services/session-transfer');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-transfer-test-'));
}

const IMG_B64 = 'A'.repeat(2000); // < 512-char runs get stripped too once inside a section body

function imageToolOutputRecord(ordinal, imageCount) {
  const blocks = [{ type: 'input_text', text: `Script completed ${ordinal}` }];
  for (let i = 0; i < imageCount; i += 1) {
    blocks.push({ type: 'input_text', text: `frame_${ordinal}_${i}.png` });
    blocks.push({ type: 'input_image', image_url: `data:image/png;base64,${IMG_B64}`, detail: 'high' });
  }
  return {
    timestamp: new Date(Date.UTC(2026, 10, 16, 13, 29, 30) + ordinal * 1000).toISOString(),
    ordinal,
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', id: `ctco_${ordinal}`, call_id: `call_${ordinal}`, output: blocks },
  };
}

function userRecord(text) {
  return {
    timestamp: '2026-11-16T13:18:40.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  };
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function run() {
  const bindPath = tmpDir();
  const jsonlPath = path.join(bindPath, 'rollout-test.jsonl');
  writeJsonl(jsonlPath, [
    userRecord('请标注这些图片'),
    imageToolOutputRecord(1, 36),
    imageToolOutputRecord(2, 2),
    userRecord(`看看这张 ${IMG_B64} 图`),
  ]);
  const sourceSession = { session_id: 'src12345', name: 'Data Annotation', description: '标注' };

  // 1) 换模型转接 (bundle): 生成成功, 图片被屏蔽, 正文无长 base64
  const bundle = writeSessionTransferBundle({
    bindPath,
    sourceSession,
    targetSessionId: 'tgt98765',
    jsonlPath,
  });
  const full = fs.readFileSync(bundle.paths.full, 'utf8');
  assert.ok(full.includes('Script completed 1'), 'text part of tool output should be kept');
  assert.ok(full.includes('frame_1_0.png'), 'image filename text should be kept');
  assert.ok(full.includes('[图片已屏蔽'), 'inline images must be replaced with a placeholder');
  assert.ok(!/[A-Za-z0-9+/]{512,}/.test(full), 'no long base64 run may survive in full.md');
  const userMd = fs.readFileSync(bundle.paths.user_messages, 'utf8');
  assert.ok(!/[A-Za-z0-9+/]{512,}/.test(userMd), 'no long base64 run may survive in user_messages.md');
  assert.ok(userMd.includes('已省略内嵌数据'), 'pasted base64 in user message is replaced');
  const meta = JSON.parse(fs.readFileSync(bundle.paths.metadata, 'utf8'));
  assert.strictEqual(meta.source_records.entry_count, 4, 'all four records parsed');

  // 2) mention 路径 (带默认截断) 同样屏蔽图片
  const capped = buildSessionTransferMarkdown({ sourceSession, targetSessionId: 'tgt98765', jsonlPath });
  assert.ok(capped.markdown.includes('[图片已屏蔽'), 'capped path also blocks images');
  assert.ok(!/[A-Za-z0-9+/]{512,}/.test(capped.markdown), 'capped path has no long base64 run');

  // 3) 超长单行 (> MAX_JSONL_LINE_CHARS) 被跳过并注明, 不炸
  const hugePath = path.join(bindPath, 'rollout-huge.jsonl');
  const hugeLine = JSON.stringify({ ...userRecord('x'), pad: 'B'.repeat(33_000_000) });
  fs.writeFileSync(hugePath, `${hugeLine}\n${JSON.stringify(userRecord('正常行'))}\n`, 'utf8');
  const bundle2 = writeSessionTransferBundle({
    bindPath,
    sourceSession,
    targetSessionId: 'tgt98766',
    jsonlPath: hugePath,
  });
  const full2 = fs.readFileSync(bundle2.paths.full, 'utf8');
  assert.ok(full2.includes('正常行'), 'normal line after the oversized one survives');
  assert.ok(full2.includes('被跳过'), 'oversized skip is noted in the document');
  assert.ok(!full2.includes('BBBB'), 'oversized line content is not carried');

  // 4) 多字节 UTF-8 跨 8MB 读块边界不撕裂 (块边界落在 CJK 字符中间)
  const cjkPath = path.join(bindPath, 'rollout-cjk.jsonl');
  const CHUNK = 8 * 1024 * 1024;
  // 动态对齐: 让 message 文本里的第一个中文字符 (3 字节) 恰好横跨第 CHUNK 字节
  const head = '{"timestamp":"2026-11-16T13:18:40.000Z","type":"event_msg","payload":{"type":"user_message","message":"';
  const pad = 'a'.repeat(CHUNK - Buffer.byteLength(head) - 1);
  const line1 = `${head}${pad}跨界的字尾部"}}`;
  const line2 = JSON.stringify(userRecord('第二行完好'));
  fs.writeFileSync(cjkPath, `${line1}\n${line2}\n`, 'utf8');
  const bundle3 = writeSessionTransferBundle({
    bindPath,
    sourceSession,
    targetSessionId: 'tgt98767',
    jsonlPath: cjkPath,
  });
  const full3 = fs.readFileSync(bundle3.paths.full, 'utf8');
  assert.ok(full3.includes('跨界的字'), 'multi-byte char split across the read boundary stays intact');
  assert.ok(full3.includes('第二行完好'), 'line after the boundary survives');

  fs.rmSync(bindPath, { recursive: true, force: true });
  console.log('session-transfer-images: all 4 checks passed');
}

run();
