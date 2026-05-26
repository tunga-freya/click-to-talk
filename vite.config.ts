import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { AccessToken } from 'livekit-server-sdk';

// Dev-mode plugin that handles /api/token without needing Vercel CLI.
// Reads LIVEKIT_* env vars from .env.local and mints a JWT.
function tokenApiDev(env: Record<string, string>): Plugin {
  return {
    name: 'token-api-dev',
    configureServer(server) {
      server.middlewares.use('/api/token', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://localhost');
          const identity = url.searchParams.get('identity') ?? '';
          const name = url.searchParams.get('name') ?? '';

          if (!identity || !name) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'identity and name required' }));
            return;
          }

          const apiKey = env.LIVEKIT_API_KEY;
          const apiSecret = env.LIVEKIT_API_SECRET;
          const lkUrl = env.LIVEKIT_URL;

          if (!apiKey || !apiSecret || !lkUrl) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'LiveKit env vars missing' }));
            return;
          }

          const at = new AccessToken(apiKey, apiSecret, {
            identity,
            name,
            ttl: '4h',
          });
          at.addGrant({
            room: 'lobby',
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
          });

          const token = await at.toJwt();
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ token, url: lkUrl }));
        } catch (e: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e?.message ?? 'token error' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tokenApiDev(env)],
    server: {
      port: 5173,
      host: true,
    },
  };
});
