/**
 * user-isolation/admin-routes.ts — 沙箱运维面 (挂载于 /api/admin/sandboxes, adminAuth).
 */
import express from 'express';
import { spawnSync } from 'child_process';
import { isDockerIsolation, USER_ISOLATION_DOCKER_IMAGE } from './config';
import * as registry from './registry';
import { rebuildNow, containerAlive, destroySandbox } from './docker-sandbox';

const router = express.Router();

router.get('/', (_req, res) => {
  if (!isDockerIsolation()) {
    res.json({ method: 'landlock', sandboxes: [] });
    return;
  }
  const sandboxes = registry.allEntries().map((e) => ({
    ...e,
    alive: containerAlive(e.user),
  }));
  res.json({ method: 'docker', image: USER_ISOLATION_DOCKER_IMAGE, sandboxes });
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
