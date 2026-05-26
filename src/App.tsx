import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────
const MAP_W = 1546;
const MAP_H = 1612;
const AVATAR_R = 24; // radius px
const HEARING_RADIUS = 280; // px — open-floor proximity range
const HEARING_FULL = 80; // px — open-floor full-volume range
const SPEED = 280; // px/sec
const POS_BROADCAST_HZ = 12; // position sends per second
const KEEPALIVE_MS = 5000; // re-broadcast position every 5s (so late joiners see us)

// ──────────────────────────────────────────────
// Private zones (Gather-style "private areas")
// Inside a zone: only people in the SAME zone hear each other (full volume).
// Crossing zone boundary instantly cuts/restores audio.
// Coordinates are in map (image) pixels — eyeballed from the office bg.
// ──────────────────────────────────────────────
interface Zone {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ZONES: Zone[] = [
  // Left column — dining/lunch booths
  { id: 'lunch-1', name: 'Lunch 1',         x:  35, y:  330, w: 310, h: 250 },
  { id: 'lunch-2', name: 'Lunch 2',         x:  35, y:  640, w: 310, h: 250 },
  { id: 'lunch-3', name: 'Lunch 3',         x:  35, y:  950, w: 310, h: 250 },
  { id: 'lunch-4', name: 'Lunch 4',         x:  35, y: 1250, w: 310, h: 260 },

  // Center — desk clusters
  { id: 'desk-alper', name: 'Dr. Alper',    x: 420, y:  370, w: 600, h: 290 },
  { id: 'desk-co-1', name: 'Co-Working 1',  x: 420, y:  720, w: 380, h: 230 },
  { id: 'desk-co-2', name: 'Desk Area',     x: 800, y:  720, w: 600, h: 290 },

  // Right side — meeting room + tunga booth
  { id: 'tunga-booth', name: 'Tunga Booth', x: 1120, y: 390, w: 360, h: 220 },
  { id: 'meeting-room', name: 'Meeting Room', x: 1100, y: 640, w: 420, h: 320 },

  // Bottom — 1-on-1 booths
  { id: '1on1-brown', name: '1-on-1 Brown', x: 380, y: 1020, w: 540, h: 280 },
  { id: '1on1-a',     name: '1-on-1',       x: 990, y: 1170, w: 280, h: 180 },
  { id: '1on1-b',     name: '1-on-1',       x: 990, y: 1380, w: 280, h: 180 },
];

function getZoneId(x: number, y: number): string | null {
  for (const z of ZONES) {
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return z.id;
  }
  return null;
}
function getZone(id: string | null): Zone | null {
  if (!id) return null;
  return ZONES.find((z) => z.id === id) ?? null;
}

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
interface PeerInfo {
  identity: string;
  name: string;
  x: number;
  y: number;
}

type Signal =
  | { type: 'pos'; from: string; fromName: string; x: number; y: number }
  | { type: 'wave'; from: string; fromName: string; to: string };

// ──────────────────────────────────────────────
// Identity
// ──────────────────────────────────────────────
function getOrCreateIdentity(): string {
  let id = localStorage.getItem('ctt_identity');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('ctt_identity', id);
  }
  return id;
}

function colorFor(id: string): string {
  const colors = [
    '#a855f7', '#ec4899', '#f97316', '#22c55e',
    '#06b6d4', '#6366f1', '#f43f5e', '#f59e0b',
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return colors[Math.abs(h) % colors.length];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// ──────────────────────────────────────────────
// App
// ──────────────────────────────────────────────
export default function App() {
  // Auth
  const [name, setName] = useState<string>(() => localStorage.getItem('ctt_name') || '');
  const [nameInput, setNameInput] = useState('');

  // Connection
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Peers (rendered)
  const [peers, setPeers] = useState<Map<string, PeerInfo>>(new Map());

  // My position (rendered)
  const [myPos, setMyPos] = useState({ x: 770, y: 800 });

  // Viewport
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });

  // Mic
  const [muted, setMuted] = useState(false);

  // Wave UI
  const [waveToast, setWaveToast] = useState<{ name: string; at: number } | null>(null);
  const [waveMenuFor, setWaveMenuFor] = useState<string | null>(null);

  // ──────────────────────────────────────────────
  // Refs
  // ──────────────────────────────────────────────
  const roomRef = useRef<Room | null>(null);
  const myIdentityRef = useRef<string>(getOrCreateIdentity());

  const heldKeysRef = useRef<Set<string>>(new Set());
  const myPosRef = useRef({ x: 770, y: 800 });
  const lastBroadcastRef = useRef(0);
  const lastKeepaliveRef = useRef(0);

  const subscribedRef = useRef<Set<string>>(new Set());

  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const peersRef = useRef<Map<string, PeerInfo>>(new Map());
  useEffect(() => { peersRef.current = peers; }, [peers]);

  // ──────────────────────────────────────────────
  // Window resize
  // ──────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ──────────────────────────────────────────────
  // Position broadcast
  // ──────────────────────────────────────────────
  const broadcastPos = useCallback(async (pos: { x: number; y: number }, force = false) => {
    const r = roomRef.current;
    if (!r) return;
    const now = performance.now();
    if (!force && now - lastBroadcastRef.current < 1000 / POS_BROADCAST_HZ) return;
    lastBroadcastRef.current = now;
    try {
      const msg: Signal = {
        type: 'pos',
        from: myIdentityRef.current,
        fromName: name,
        x: pos.x,
        y: pos.y,
      };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      await r.localParticipant.publishData(data, { reliable: false });
    } catch (e) {
      console.warn('broadcast failed', e);
    }
  }, [name]);

  // ──────────────────────────────────────────────
  // Signal handling
  // ──────────────────────────────────────────────
  const handleSignal = useCallback((msg: Signal) => {
    if (msg.type === 'pos') {
      setPeers((prev) => {
        const next = new Map(prev);
        next.set(msg.from, {
          identity: msg.from,
          name: msg.fromName,
          x: msg.x,
          y: msg.y,
        });
        return next;
      });
    } else if (msg.type === 'wave') {
      if (msg.to !== myIdentityRef.current) return;
      try {
        const audio = new Audio('/wave.wav');
        audio.volume = 1.0;
        audio.play().catch((e) => console.warn('wave play blocked', e));
      } catch {}
      setWaveToast({ name: msg.fromName, at: Date.now() });
    }
  }, []);

  // ──────────────────────────────────────────────
  // Connect to LiveKit lobby
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    let room: Room | null = null;

    const connect = async () => {
      try {
        const res = await fetch(
          `/api/token?identity=${encodeURIComponent(myIdentityRef.current)}&name=${encodeURIComponent(name)}`
        );
        if (!res.ok) throw new Error(`Token endpoint ${res.status}`);
        const { token, url } = await res.json();

        room = new Room({ adaptiveStream: false, dynacast: false });

        room.on(RoomEvent.ParticipantConnected, () => {
          broadcastPos(myPosRef.current, true);
        });

        room.on(RoomEvent.ParticipantDisconnected, (p) => {
          setPeers((prev) => {
            const next = new Map(prev);
            next.delete(p.identity);
            return next;
          });
          subscribedRef.current.delete(p.identity);
        });

        room.on(RoomEvent.DataReceived, (payload, participant) => {
          if (!participant) return;
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload)) as Signal;
            handleSignal(msg);
          } catch (e) {
            console.warn('bad data packet', e);
          }
        });

        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach() as HTMLAudioElement;
            el.id = `audio-${participant.identity}`;
            el.autoplay = true;
            el.volume = 0;
            document.body.appendChild(el);
          }
        });

        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
        });

        room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant) => {
          if (subscribedRef.current.has(participant.identity) && pub.kind === Track.Kind.Audio) {
            pub.setSubscribed(true);
          }
        });

        room.on(RoomEvent.Disconnected, () => setConnected(false));

        await room.connect(url, token, { autoSubscribe: false });
        if (cancelled) {
          room.disconnect();
          return;
        }

        await room.localParticipant.setMicrophoneEnabled(false);

        roomRef.current = room;
        setConnected(true);
        broadcastPos(myPosRef.current, true);
      } catch (e: any) {
        console.error('Connect failed', e);
        setError(e?.message ?? 'Failed to connect');
      }
    };

    connect();

    return () => {
      cancelled = true;
      room?.disconnect();
      roomRef.current = null;
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // ──────────────────────────────────────────────
  // Keyboard input
  // ──────────────────────────────────────────────
  useEffect(() => {
    const MOVE_KEYS = new Set([
      'w', 'a', 's', 'd',
      'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    ]);
    const onDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) {
        e.preventDefault();
        heldKeysRef.current.add(k);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) {
        e.preventDefault();
        heldKeysRef.current.delete(k);
      }
    };
    const onBlur = () => heldKeysRef.current.clear();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ──────────────────────────────────────────────
  // Proximity audio engine
  // ──────────────────────────────────────────────
  const updateProximityAudio = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;

    const me = myPosRef.current;
    const myZone = getZoneId(me.x, me.y);
    let anyoneAudible = false;

    peersRef.current.forEach((peer, id) => {
      const remote = r.remoteParticipants.get(id);
      if (!remote) return;

      const peerZone = getZoneId(peer.x, peer.y);

      // ── Determine if I should hear this peer + at what volume
      // Rule:
      //  - If I'm in any zone OR peer is in any zone → only same-zone members hear each other
      //  - Inside the same zone, audio is FULL volume (no distance falloff)
      //  - If both of us are in the open floor → distance-based proximity
      let audible = false;
      let volume = 0;

      if (myZone !== null || peerZone !== null) {
        if (myZone !== null && myZone === peerZone) {
          audible = true;
          volume = 1.0;
        } else {
          audible = false;
        }
      } else {
        const d = Math.hypot(me.x - peer.x, me.y - peer.y);
        if (d < HEARING_RADIUS) {
          audible = true;
          if (d <= HEARING_FULL) volume = 1.0;
          else volume = Math.max(0, 1 - (d - HEARING_FULL) / (HEARING_RADIUS - HEARING_FULL));
        }
      }

      const was = subscribedRef.current.has(id);
      if (audible && !was) {
        remote.audioTrackPublications.forEach((pub) => pub.setSubscribed(true));
        subscribedRef.current.add(id);
      } else if (!audible && was) {
        remote.audioTrackPublications.forEach((pub) => pub.setSubscribed(false));
        subscribedRef.current.delete(id);
      }

      if (audible) {
        anyoneAudible = true;
        const el = document.getElementById(`audio-${id}`) as HTMLAudioElement | null;
        if (el) el.volume = volume;
      }
    });

    const want = anyoneAudible && !mutedRef.current;
    if (r.localParticipant.isMicrophoneEnabled !== want) {
      r.localParticipant.setMicrophoneEnabled(want).catch(() => {});
    }
  }, []);

  // ──────────────────────────────────────────────
  // Main loop: movement + proximity
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!connected) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const k = heldKeysRef.current;
      let dx = 0, dy = 0;
      if (k.has('w') || k.has('arrowup')) dy -= 1;
      if (k.has('s') || k.has('arrowdown')) dy += 1;
      if (k.has('a') || k.has('arrowleft')) dx -= 1;
      if (k.has('d') || k.has('arrowright')) dx += 1;

      let moved = false;
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const nx = clamp(myPosRef.current.x + (dx / len) * SPEED * dt, AVATAR_R, MAP_W - AVATAR_R);
        const ny = clamp(myPosRef.current.y + (dy / len) * SPEED * dt, AVATAR_R, MAP_H - AVATAR_R);
        if (nx !== myPosRef.current.x || ny !== myPosRef.current.y) {
          myPosRef.current = { x: nx, y: ny };
          setMyPos({ x: nx, y: ny });
          moved = true;
        }
      }

      if (moved) broadcastPos(myPosRef.current);

      if (now - lastKeepaliveRef.current > KEEPALIVE_MS) {
        lastKeepaliveRef.current = now;
        broadcastPos(myPosRef.current, true);
      }

      updateProximityAudio();

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // ──────────────────────────────────────────────
  // Wave toast dismiss
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!waveToast) return;
    const t = setTimeout(() => setWaveToast(null), 3000);
    return () => clearTimeout(t);
  }, [waveToast]);

  // ──────────────────────────────────────────────
  // Actions
  // ──────────────────────────────────────────────
  const onJoin = () => {
    const v = nameInput.trim();
    if (!v) return;
    localStorage.setItem('ctt_name', v);
    setName(v);
  };

  const onChangeName = () => {
    localStorage.removeItem('ctt_name');
    setName('');
    setNameInput('');
  };

  const sendWave = useCallback(async (peerId: string) => {
    const r = roomRef.current;
    if (!r) return;
    const msg: Signal = {
      type: 'wave',
      from: myIdentityRef.current,
      fromName: name,
      to: peerId,
    };
    const data = new TextEncoder().encode(JSON.stringify(msg));
    await r.localParticipant.publishData(data, { reliable: true });
  }, [name]);

  // ──────────────────────────────────────────────
  // Render: name entry
  // ──────────────────────────────────────────────
  if (!name) {
    return (
      <div className="min-h-screen flex items-center justify-center office-bg">
        <div className="bg-white p-8 rounded-2xl shadow-xl w-96 relative">
          <h1 className="text-3xl font-bold mb-2">Click to Talk</h1>
          <p className="text-gray-600 mb-6">Type a name to enter the office.</p>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onJoin()}
            placeholder="Your name"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-400"
            autoFocus
          />
          <button
            onClick={onJoin}
            className="w-full bg-blue-500 text-white py-3 rounded-lg hover:bg-blue-600 font-semibold transition"
          >
            Enter
          </button>
        </div>
      </div>
    );
  }

  // Camera: world is translated so my avatar is centered in viewport
  const camX = viewport.w / 2 - myPos.x;
  const camY = viewport.h / 2 - myPos.y;

  // Current zone (mine) and occupant counts per zone
  const myZoneId = getZoneId(myPos.x, myPos.y);
  const myZone = getZone(myZoneId);
  const zoneCounts = new Map<string, number>();
  if (myZoneId) zoneCounts.set(myZoneId, 1);
  peers.forEach((p) => {
    const z = getZoneId(p.x, p.y);
    if (z) zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
  });

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b1020]">
      {/* World layer */}
      <div
        className="absolute"
        style={{
          width: MAP_W,
          height: MAP_H,
          transform: `translate(${camX}px, ${camY}px)`,
          backgroundImage: 'url(/office-bg.png)',
          backgroundSize: '100% 100%',
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated' as any,
        }}
      >
        {/* Private zone overlays */}
        {ZONES.map((z) => {
          const isMine = z.id === myZoneId;
          const count = zoneCounts.get(z.id) ?? 0;
          return (
            <div
              key={z.id}
              className="absolute pointer-events-none rounded-md"
              style={{
                left: z.x,
                top: z.y,
                width: z.w,
                height: z.h,
                background: isMine
                  ? 'rgba(236, 72, 153, 0.32)'
                  : 'rgba(236, 72, 153, 0.18)',
                border: isMine
                  ? '3px solid rgba(244, 114, 182, 0.95)'
                  : '2px dashed rgba(236, 72, 153, 0.55)',
                boxShadow: isMine
                  ? '0 0 24px rgba(244,114,182,0.7) inset'
                  : 'none',
              }}
            >
              <div
                className="absolute left-1.5 top-1 px-2 py-0.5 rounded-md text-white text-[11px] font-bold tracking-wide"
                style={{
                  background: isMine ? 'rgba(190, 24, 93, 0.95)' : 'rgba(0,0,0,0.55)',
                  backdropFilter: 'blur(4px)',
                }}
              >
                {z.name}{count > 0 ? ` · ${count}` : ''}
              </div>
            </div>
          );
        })}

        {/* My avatar (with hearing ring only when in open floor) */}
        <Avatar
          x={myPos.x}
          y={myPos.y}
          name={name + ' (you)'}
          color="#3b82f6"
          isMe
          showHearingRing={!myZoneId}
        />

        {/* Other avatars */}
        {Array.from(peers.values()).map((p) => {
          const d = Math.hypot(myPos.x - p.x, myPos.y - p.y);
          const near = d < HEARING_RADIUS;
          return (
            <Avatar
              key={p.identity}
              x={p.x}
              y={p.y}
              name={p.name}
              color={colorFor(p.identity)}
              near={near}
              onClick={() => setWaveMenuFor(waveMenuFor === p.identity ? null : p.identity)}
              menuOpen={waveMenuFor === p.identity}
              onWave={() => {
                sendWave(p.identity);
                setWaveMenuFor(null);
              }}
            />
          );
        })}
      </div>

      {/* HUD top bar */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between z-30 pointer-events-none">
        <div className="flex flex-col gap-2">
          <div className="bg-black/55 backdrop-blur px-4 py-2 rounded-2xl text-white text-sm flex items-center gap-3 pointer-events-auto">
            <span className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-400'}`} />
              {connected ? 'Online' : 'Connecting…'}
            </span>
            <span className="opacity-50">·</span>
            <span><b>{name}</b></span>
            <span className="opacity-50">·</span>
            <span>{peers.size + 1} in office</span>
            <button
              onClick={onChangeName}
              className="text-blue-300 hover:text-blue-200 text-xs ml-2"
            >
              change
            </button>
          </div>
          {myZone && (
            <div className="bg-pink-600/90 backdrop-blur px-4 py-2 rounded-2xl text-white text-sm flex items-center gap-2 pointer-events-auto self-start shadow-lg">
              <span className="text-base">🔒</span>
              <span>
                In <b>{myZone.name}</b>
                {(zoneCounts.get(myZone.id) ?? 1) > 1
                  ? ` · ${zoneCounts.get(myZone.id)} people`
                  : ' · just you'}
              </span>
            </div>
          )}
        </div>

        <div className="bg-black/55 backdrop-blur px-4 py-2 rounded-2xl text-white text-sm pointer-events-auto flex items-center gap-3">
          <button
            onClick={() => setMuted((m) => !m)}
            className={`px-3 py-1 rounded-lg font-medium ${
              muted ? 'bg-yellow-500 text-black' : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            {muted ? '🔇 Muted' : '🎙 Mic on'}
          </button>
        </div>
      </div>

      {/* Bottom hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-black/55 backdrop-blur px-5 py-2 rounded-full text-white text-sm flex items-center gap-4 flex-wrap justify-center max-w-[90vw]">
        <span><b>WASD</b> / arrows to move</span>
        <span className="opacity-40">·</span>
        <span>Open floor: walk close to talk</span>
        <span className="opacity-40">·</span>
        <span>Pink zones: <b>private</b> — only same-zone talks</span>
        <span className="opacity-40">·</span>
        <span>Click avatar to 👋 <b>Wave</b></span>
      </div>

      {/* Error */}
      {error && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-red-100 border border-red-300 text-red-700 px-4 py-2 rounded-lg z-40">
          {error}
        </div>
      )}

      {/* Wave received toast */}
      {waveToast && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-indigo-500 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 z-40 animate-bounce">
          <span className="text-2xl">👋</span>
          <span className="font-medium">{waveToast.name} waved at you</span>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Avatar
// ──────────────────────────────────────────────
interface AvatarProps {
  x: number;
  y: number;
  name: string;
  color: string;
  isMe?: boolean;
  near?: boolean;
  showHearingRing?: boolean;
  onClick?: () => void;
  menuOpen?: boolean;
  onWave?: () => void;
}

function Avatar({
  x, y, name, color, isMe, near, showHearingRing, onClick, menuOpen, onWave,
}: AvatarProps) {
  return (
    <div
      className="absolute"
      style={{
        left: x - AVATAR_R,
        top: y - AVATAR_R,
        width: AVATAR_R * 2,
        height: AVATAR_R * 2,
        transition: 'left 80ms linear, top 80ms linear',
      }}
    >
      {showHearingRing && (
        <div
          className="absolute rounded-full border-2 border-blue-300/40 pointer-events-none"
          style={{
            left: AVATAR_R - HEARING_RADIUS,
            top: AVATAR_R - HEARING_RADIUS,
            width: HEARING_RADIUS * 2,
            height: HEARING_RADIUS * 2,
          }}
        />
      )}

      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={`relative w-full h-full rounded-full flex items-center justify-center text-white text-xl font-bold shadow-lg transition ${
          onClick ? 'hover:scale-110 cursor-pointer' : 'cursor-default'
        } ${near ? 'ring-4 ring-green-300/70' : isMe ? 'ring-4 ring-blue-200' : ''}`}
        style={{ backgroundColor: color }}
      >
        {name[0]?.toUpperCase()}
      </button>

      <div
        className="absolute left-1/2 -translate-x-1/2 -bottom-7 text-xs font-semibold text-white whitespace-nowrap px-2 py-0.5 rounded-full"
        style={{ backgroundColor: isMe ? '#2563ebcc' : '#00000099', backdropFilter: 'blur(4px)' }}
      >
        {name}
      </div>

      {menuOpen && onWave && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-6 bg-white rounded-xl shadow-2xl border border-gray-200 z-20">
          <button
            onClick={onWave}
            className="px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white font-semibold flex items-center gap-2 whitespace-nowrap"
          >
            <span>👋</span>
            <span>Wave</span>
          </button>
        </div>
      )}
    </div>
  );
}
