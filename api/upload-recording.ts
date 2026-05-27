// /api/upload-recording — initiates a Drive resumable upload session
// using a Google service account, and returns the session URL so the
// browser can PUT the blob directly to Google (bypassing Vercel's 4.5MB
// request-body limit).
//
// REQUIRED Vercel environment variables:
//   GOOGLE_SERVICE_ACCOUNT_JSON   – the full JSON key for a service account
//                                   (paste the file contents as a single var)
//   GOOGLE_DRIVE_FOLDER_ID        – the ID of the Drive folder to upload into
//                                   (must be shared with the service account
//                                   email as Editor)
//
// If either env var is missing the endpoint returns 501 Not Configured
// and the client falls back to local-download-only.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleAuth } from 'google-auth-library';

interface InitBody {
  filename: string;
  mimeType: string;
  size: number;
  owner?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const credsRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!credsRaw || !folderId) {
    return res.status(501).json({
      error: 'Drive upload not configured',
      hint:
        'Set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_FOLDER_ID env vars on Vercel. See README.md.',
    });
  }

  let creds: { client_email?: string; private_key?: string };
  try {
    creds = JSON.parse(credsRaw);
  } catch {
    return res
      .status(500)
      .json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON' });
  }

  let body: InitBody;
  try {
    body =
      typeof req.body === 'string'
        ? (JSON.parse(req.body) as InitBody)
        : (req.body as InitBody);
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  const { filename, mimeType, size, owner } = body || ({} as InitBody);
  if (!filename || !mimeType) {
    return res.status(400).json({ error: 'filename and mimeType required' });
  }

  try {
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;
    if (!accessToken) {
      return res.status(500).json({ error: 'no access token from service account' });
    }

    // Initiate a resumable upload session in the target Drive folder.
    const metadata = {
      name: filename,
      mimeType,
      parents: [folderId],
      description: owner ? `Recorded by ${owner}` : undefined,
    };
    const initRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size || 0),
        },
        body: JSON.stringify(metadata),
      }
    );

    if (!initRes.ok) {
      const text = await initRes.text();
      return res.status(502).json({
        error: 'Drive resumable init failed',
        status: initRes.status,
        detail: text,
      });
    }

    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) {
      return res.status(502).json({ error: 'Drive did not return a resumable URL' });
    }

    return res.status(200).json({
      uploadUrl,
      folderId,
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    return res.status(500).json({ error: err?.message ?? String(e) });
  }
}
