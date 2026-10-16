/**
 * user-isolation/admin-routes.ts — 沙箱运维面 (挂载于 /api/admin/sandboxes, adminAuth).
 */
import express from 'express';
import { spawnSync } from 'child_process';
import { isDockerIsolation, USER_ISOLATION_DOCKER_IMAGE, SBX_IDLE_DESTROY_MS } from './config';
import * as registry from './registry';
import { rebuildNow, containerAlive, destroySandbox } from './docker-sandbox';

const router = express.Router();

router.get('/', async (req, res) => {
  if (!isDockerIsolation()) {
    res.json({ method: 'landlock', sandboxes: [], selfCheck: null });
    return;
  }
  const { runSelfCheck, selfCheckResult } = require('./selfcheck');
  // ?refresh=1 强制重跑四步自检 (daemon/镜像/挂卷/端口)
  const selfCheck = String(req.query.refresh) === '1' ? await runSelfCheck(true) : (selfCheckResult() || await runSelfCheck());
  const sandboxes = registry.allEntries().map((e) => ({
    ...e,
    alive: containerAlive(e.user),
  }));
  // idleDestroyMs 下发给前端算"销毁倒计时" (心跳制: lastActiveAt + idleDestroyMs 被 reaper 回收)
  res.json({ method: 'docker', image: USER_ISOLATION_DOCKER_IMAGE, idleDestroyMs: SBX_IDLE_DESTROY_MS, sandboxes, selfCheck });
});

router.post('/:userId/rebuild', (req, res) => {
  if (!isDockerIsolation()) { res.status(400).json({ error: '当前不是 docker 隔离模式' }); return; }
  try {
    rebuildNow([req.params.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post('/:userId/stop', (req, res) => {
  if (!isDockerIsolation()) { res.status(400).json({ error: '当前不是 docker 隔离模式' }); return; }
  destroySandbox(String(req.params.userId));
  res.json({ ok: true });
});

export = router;
