import express from 'express';
import { auth } from '../middleware/auth';
// @ts-ignore — service 仍是 .js, 无类型声明
import * as aimuxRemote from '../services/aimux-remote';

const router = express.Router();

router.get('/remotes', auth, async (req: express.Request, res: express.Response) => {
  try {
    const remotes = await aimuxRemote.listRemotes();
    res.json({ remotes });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || '读取 aimux remote 清单失败' });
  }
});

router.post('/remotes/test', auth, async (req: express.Request, res: express.Response) => {
  try {
    const body = (req.body || {}) as { name?: string; timeout?: number };
    const result = await aimuxRemote.testRemote(body.name, body.timeout);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '测试 aimux remote 失败' });
  }
});

router.post('/remotes/hardware', auth, async (req: express.Request, res: express.Response) => {
  try {
    const body = (req.body || {}) as { name?: string; timeout?: number };
    const result = await aimuxRemote.hardwareRemote(body.name, body.timeout);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '探测 aimux remote 硬件失败' });
  }
});

router.post('/remotes/browse', auth, async (req: express.Request, res: express.Response) => {
  try {
    const body = (req.body || {}) as { name?: string; path?: string; timeout?: number };
    const result = await aimuxRemote.browseRemotePath(body.name, body.path, body.timeout);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '浏览 aimux remote 路径失败' });
  }
});

router.post('/remotes', auth, async (req: express.Request, res: express.Response) => {
  try {
    const result = await aimuxRemote.addRemote(req.body || {});
    res.json(result);
  } catch (e) {
    const err = e as Error & { result?: unknown };
    res.status(400).json({
      error: err.message || '添加 aimux remote 失败',
      detail: err.result || null,
    });
  }
});

export = router;
