import express from 'express';
import { auth } from '../middleware/auth';
import { Messages } from '../repositories/messages';

const router = express.Router();

router.patch('/:id/bookmark', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Bad id' });
    return;
  }
  const msg = Messages.findWithUser(id);
  if (!msg || msg.user_id !== user.id) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const newVal = msg.bookmarked ? 0 : 1;
  Messages.setBookmark(id, newVal);
  res.json({ id: msg.id, bookmarked: newVal });
});

export = router;
