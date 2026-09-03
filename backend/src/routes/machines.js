import express from 'express';
import { listMachines, mintWorkerToken, revokeMachine } from '../worker-tokens.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ machines: listMachines() });
});

// The token is returned here and nowhere else: only its digest is kept.
router.post('/', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

  if (name.length === 0 || name.length > 80) {
    return res.status(400).json({ error: 'A machine needs a name of 1 to 80 characters' });
  }

  const minted = mintWorkerToken({ name, createdBy: req.user.username });

  console.log(`Worker credential issued for ${name} by ${req.user.username}`);

  res.status(201).json(minted);
});

router.delete('/:id', (req, res) => {
  const result = revokeMachine(req.params.id);

  if (!result.success) {
    return res.status(result.status).json({ error: result.error });
  }

  console.log(`Worker credential for ${result.name} revoked by ${req.user.username}`);

  res.json({ revoked: true });
});

export default router;
