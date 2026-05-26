# Click to Talk

A dead-simple "Discord huddle" replacement. Everyone in the lobby shows up as a
circle. Click someone → `Talk` → they hear a ring → they accept → you are
talking. Hang up. That is the entire app.

No avatars. No maps. No game engine. Voice only (no video in v1).

---

## What you need (5 minutes total)

1. **LiveKit Cloud account** (free) — handles the actual WebRTC.
   → https://cloud.livekit.io
2. **Vercel account** (free) — hosts the app.
   → https://vercel.com

That's it. No database, no Supabase, no Clerk.

---

## Setup

### 1. Get LiveKit credentials

1. Go to https://cloud.livekit.io, sign in.
2. Create a new project (any name, e.g. `click-to-talk`).
3. Open **Settings → Keys**. You will see:
   - `API Key` (starts with `API…`)
   - `API Secret`
   - Project URL (e.g. `wss://click-to-talk-xxxx.livekit.cloud`)
4. Copy all three. You'll paste them into Vercel in step 3.

### 2. Push this folder to GitHub

```bash
cd click-to-talk
git init
git add .
git commit -m "initial"
git branch -M main
# Create a new empty repo on github.com first, then:
git remote add origin https://github.com/<your-username>/click-to-talk.git
git push -u origin main
```

### 3. Deploy on Vercel

1. Go to https://vercel.com/new
2. Import the GitHub repo you just pushed.
3. Framework preset: **Vite** (auto-detected).
4. Before clicking Deploy, expand **Environment Variables** and add the three from LiveKit:

   | Name | Value |
   |---|---|
   | `LIVEKIT_API_KEY` | `APIxxxxxxxx…` |
   | `LIVEKIT_API_SECRET` | `secretxxxxxxxxxxx…` |
   | `LIVEKIT_URL` | `wss://yourproject-xxxx.livekit.cloud` |

5. Click **Deploy**. ~1 minute.
6. You will get a URL like `https://click-to-talk-xxx.vercel.app`.

### 4. Try it

1. Open the Vercel URL in your browser. Type a name → Join.
2. Send the same URL to your friend. They open it, type a name, Join.
3. You see their circle appear next to yours.
4. Click their circle → `Talk` → they get a ringing modal → Accept → talk.
5. Hang up. Done.

---

## Local development (optional)

If you want to develop locally:

```bash
npm install
npm install -g vercel  # one-time
vercel login            # one-time
vercel link             # link the local folder to your Vercel project

# Pull env vars from Vercel into a local .env file
vercel env pull .env.local

# Run dev server (handles both /api routes and Vite together)
vercel dev
```

Then open http://localhost:3000 in two different browsers (Chrome + Safari, or
one normal + one incognito) to test with yourself.

> If you don't want to install Vercel CLI, you can also just deploy to a preview
> environment on every push and test there.

---

## How it works (architecture)

```
Browser A                 LiveKit Cloud                 Browser B
   │                            │                          │
   │  GET /api/token            │                          │
   │ ─────────────────►         │                          │
   │  (Vercel function)         │                          │
   │  returns JWT               │                          │
   │                            │                          │
   │  connect to "lobby" room                              │
   │ ──────────────────────────►│                          │
   │                            │◄─── B connects ──────────│
   │                            │                          │
   │  publishData("invite")  ──►│──► forwards ────────────►│
   │                            │                          │
   │                            │◄── publishData("accept") │
   │  receives accept    ◄──────│                          │
   │                            │                          │
   │  setMicrophoneEnabled(true)│                          │
   │  setSubscribed(B, true)    │                          │
   │                            │                          │
   │  ◄═════ audio flowing ════════════════════════════════►
   │                            │                          │
```

- Everyone joins a single LiveKit room called `lobby`.
- `autoSubscribe: false` — you don't hear anyone by default.
- Microphone is published but **disabled** while idle.
- Call invites travel through LiveKit's data channel (no separate signaling server).
- On accept, both peers enable their mic and subscribe to each other's audio
  track. Other people in the lobby still don't hear you because they aren't
  subscribed.
- On hang up, both unsubscribe and disable their mic.

This is the same "selective subscription" pattern Gather, LiveKit's spatial
demo, and similar apps use — just without the spatial-audio attenuation curve.

---

## Tech

- React 18 + Vite + TypeScript
- Tailwind CSS
- LiveKit (client SDK + server SDK for token minting)
- Vercel serverless function for `/api/token`

Single dependency tree, ~500 lines of code total.

---

## Limits / known gaps (v1)

- 1-to-1 calls only. If you're in a call and someone else calls you, they
  auto-decline.
- No video, no screen share, no text chat.
- No persistent user IDs across devices — identity is a `localStorage` UUID, so
  switching browsers makes you a new person.
- Profile photos are just colored circles with the first letter of your name.
- No call history.

Each of these is a one-evening feature add if you want it later.

---

## Costs

- LiveKit Cloud free tier: 100 concurrent participants + 50 GB egress / month.
  For 2 people doing 1-to-1 calls, you will not come close to the limit.
- Vercel free tier: 100 GB bandwidth, unlimited function invocations.

For ~10 friends using this casually, $0/month.

---

## File map

```
click-to-talk/
├── api/
│   └── token.ts          ← Vercel serverless function, mints LiveKit JWTs
├── src/
│   ├── App.tsx           ← The whole app (~450 LoC)
│   ├── main.tsx
│   ├── index.css
│   └── vite-env.d.ts
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── .env.example          ← Copy to .env.local for local dev
├── .gitignore
└── README.md
```
