'use strict';
const { runSelfTest } = require('./self-test-lib');

if (!process.env.JWT_SECRET) { console.error('❌ env JWT_SECRET 未设置'); process.exit(2); }

const base = process.env.MOBIUS_SELF_TEST_BASE || `http://127.0.0.1:${process.env.MOBIUS_PORT || '33316'}`;
const doWrite = /^(1|true|yes)$/i.test(process.env.MOBIUS_SELF_TEST_WRITE || '');

(async () => {
  console.log(`\n=== Mobius 自检  base=${base}  write=${doWrite} ===`);
  const r = await runSelfTest({ base, doWrite, timeoutMs: Number(process.env.MOBIUS_SELF_TEST_TIMEOUT_MS || 8000),
    onCheck: (name, ok, ms, err, skipped, reason) => {
      if (skipped) console.log(`⏭  ${name}  (跳过: ${reason})`);
      else if (ok) console.log(`✅ ${name}  (${ms}ms)`);
      else console.log(`❌ ${name}  (${ms}ms)  ${err}`);
    },
  });
  console.log(`\n=== 汇总: ✅${r.pass}  ❌${r.fail}  ⏭${r.skipped}  (耗时 ${r.durationMs}ms) ===`);
  console.log(`SELF_TEST_JSON ${JSON.stringify(r)}`);
  process.exit(r.fail ? 1 : 0);
})().catch((e) => { console.error('自检脚本异常:', e); process.exit(1); });
