import { AccessToken } from 'livekit-server-sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const identity = String(req.query.identity || '');
  const name = String(req.query.name || '');

  if (!identity || !name) {
    return res.status(400).json({ error: 'identity and name required' });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !url) {
    return res.status(500).json({ error: 'LiveKit env vars not configured' });
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
  res.status(200).json({ token, url });
}
