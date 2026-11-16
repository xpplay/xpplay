import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './src/server/routes/api.ts';
import { expireOverdueCampaignsServer } from './src/server/services/xpEngineServer.ts';
import { isAdminSdkAvailable } from './src/server/firebaseServer.ts';

const PORT = 3000;

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // API Routes
  app.use('/api', apiRouter);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Periodic background expiration worker (every 5 minutes when Admin SDK is active)
  if (isAdminSdkAvailable()) {
    setInterval(() => {
      expireOverdueCampaignsServer().catch(() => {});
    }, 5 * 60 * 1000);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[XP PLAY] Server berjalan pada http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[XP PLAY] Gagal menjalankan server:', err);
  process.exit(1);
});
