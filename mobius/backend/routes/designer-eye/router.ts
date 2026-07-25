import express from 'express';
import path from 'path';
import { adminAuth } from '../../middleware/auth';
import { APP_DIR } from '../../config';
// @ts-ignore — registry maintains the extension allow-list and source roots.
import * as registry from '../../services/extension-registry';
import { locateSourceCandidates, type LocatorSignal } from './locator';

const router = express.Router();

router.post('/locate', adminAuth, (req: express.Request, res: express.Response) => {
  const page = req.body?.page && typeof req.body.page === 'object' ? req.body.page : {};
  const scope = page.scope === 'extension' ? 'extension' : 'core';
  let root: string;

  if (scope === 'extension') {
    const extensionName = String(page.extensionName || '');
    if (!registry.EXT_NAME_RE.test(extensionName)) {
      res.status(400).json({ error: '非法拓展名' });
      return;
    }
    const entry = registry.get(extensionName);
    if (!entry?.frontend_dir) {
      res.status(404).json({ error: '拓展前端不存在或未注册' });
      return;
    }
    root = entry.frontend_dir;
  } else {
    root = path.join(APP_DIR, 'mobius', 'frontend', 'src');
  }

  try {
    const result = locateSourceCandidates({
      scope,
      root,
      routePath: String(page.path || '').slice(0, 500),
      signals: (Array.isArray(req.body?.signals) ? req.body.signals : []) as LocatorSignal[],
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '源码定位失败' });
  }
});

export = router;
