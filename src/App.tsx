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
const MAP_W = 2000;
const MAP_H = 1104;
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

// Generated via /zone-editor.html — Tunga's labeled private areas on the new 2000×1104 map.
const ZONES: Zone[] = [
  // Top row of desks (Ricky / Alper)
  { id: 'ricky',       name: 'Ricky',       x: 707,  y: 270, w: 116, h: 70 },
  { id: 'alper',       name: 'Alper',       x: 942,  y: 269, w: 114, h: 71 },

  // Second row (Yavuz / Ahmet / Tunga)
  { id: 'yavuz',       name: 'Yavuz',       x: 707,  y: 342, w: 117, h: 75 },
  { id: 'ahmet',       name: 'Ahmet',       x: 825,  y: 341, w: 120, h: 76 },
  { id: 'tunga',       name: 'Tunga',       x: 945,  y: 345, w: 110, h: 72 },

  // Center cluster (Yunus Emre / Tom / Can)
  { id: 'yunus-emre',  name: 'Yunus Emre',  x: 902,  y: 462, w: 116, h: 74 },
  { id: 'tom',         name: 'Tom',         x: 1018, y: 463, w: 114, h: 73 },
  { id: 'can',         name: 'Can',         x: 1132, y: 464, w: 123, h: 73 },

  // Lower center (Yusuf / Mustafa / Omer)
  { id: 'yusuf',       name: 'Yusuf',       x: 902,  y: 537, w: 116, h: 80 },
  { id: 'mustafa',     name: 'Mustafa',     x: 1017, y: 538, w: 118, h: 77 },
  { id: 'omer',        name: 'Omer',        x: 1135, y: 538, w: 114, h: 76 },

  // Bottom row (Yalin / Serkan / Misra)
  { id: 'yalin',       name: 'Yalin',       x: 673,  y: 655, w: 114, h: 74 },
  { id: 'serkan',      name: 'Serkan',      x: 787,  y: 656, w: 115, h: 71 },
  { id: 'misra',       name: 'Misra',       x: 905,  y: 656, w: 116, h: 73 },

  // Shared rooms
  { id: 'meeting-room', name: 'Meeting Room', x: 1328, y: 112, w: 306, h: 236 },
  { id: 'table-1',     name: 'Table 1',     x: 1100, y: 271, w: 148, h: 117 },
  { id: 'table-2',     name: 'Table 2',     x: 712,  y: 457, w: 153, h: 120 },
  { id: '1-1-room',    name: '1-1 Room',    x: 1140, y: 692, w: 106, h:  39 },
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
  const [myPos, setMyPos] = useState({ x: 900, y: 870 });

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
  const myPosRef = useRef({ x: 900, y: 870 });
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
        {/* Private zone overlays — Gather-style: subtle lighter background, no border */}
        {ZONES.map((z) => {
          const isMine = z.id === myZoneId;
          const count = zoneCounts.get(z.id) ?? 0;
          if (!isMine && count === 0) return null; // Gather only highlights occupied zones
          return (
            <div
              key={z.id}
              className="absolute pointer-events-none"
              style={{
                left: z.x,
                top: z.y,
                width: z.w,
                height: z.h,
                background: isMine
                  ? 'rgba(255, 255, 255, 0.22)'
                  : 'rgba(255, 255, 255, 0.10)',
                borderRadius: 6,
              }}
            />
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
          const peerZone = getZone(getZoneId(p.x, p.y));
          return (
            <Avatar
              key={p.identity}
              x={p.x}
              y={p.y}
              name={p.name}
              color={colorFor(p.identity)}
              near={near}
              zoneName={peerZone?.name ?? null}
              onClick={() => setWaveMenuFor(waveMenuFor === p.identity ? null : p.identity)}
              menuOpen={waveMenuFor === p.identity}
              onCloseMenu={() => setWaveMenuFor(null)}
              onWave={() => {
                sendWave(p.identity);
                setWaveMenuFor(null);
              }}
            />
          );
        })}
      </div>

      {/* Top bar — Gather-style */}
      <div className="absolute top-0 left-0 right-0 h-12 bg-[#0e1320]/95 backdrop-blur border-b border-white/5 flex items-center justify-between px-4 z-30 text-white">
        <div className="flex items-center gap-3 text-gray-400 text-sm">
          <button className="hover:text-white opacity-70" title="Copy invite link">🔗</button>
          <button className="hover:text-white opacity-70" title="Privacy">🔓</button>
          {peers.size > 0 && (
            <span className="flex items-center gap-1 opacity-80">
              <span>👥</span>
              <span>{peers.size + 1}</span>
            </span>
          )}
        </div>

        <button className="flex items-center gap-2 text-sm font-medium hover:bg-white/5 px-3 py-1.5 rounded-lg transition">
          <span className="text-pink-400">📍</span>
          <span>{myZone ? myZone.name : 'Open floor'}</span>
          <span className="text-gray-500 text-xs">▾</span>
        </button>

        <div className="flex items-center gap-2">
          <button className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 flex items-center gap-2 font-medium">
            <span>🗺</span>
            <span>Map view</span>
          </button>
          <button className="text-gray-400 hover:text-white p-1">⋮</button>
        </div>
      </div>

      {/* Bottom action bar — Gather-style */}
      <div className="absolute bottom-0 left-0 right-0 bg-[#0e1320]/95 backdrop-blur border-t border-white/5 px-4 py-2.5 flex items-center justify-between z-30 text-white">
        {/* Left: self avatar + name + status */}
        <button
          onClick={onChangeName}
          className="flex items-center gap-3 hover:bg-white/5 rounded-lg px-2 py-1 transition group"
          title="Change name"
        >
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white font-bold text-lg">
              {name[0]?.toUpperCase()}
            </div>
            <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-[#0e1320] ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
          </div>
          <div className="text-left">
            <div className="font-medium text-sm leading-tight">{name}</div>
            <div className="text-gray-400 text-xs leading-tight">
              {myZone ? `at ${myZone.name}` : 'Open floor'}
            </div>
          </div>
          <span className="text-gray-500 opacity-0 group-hover:opacity-100 transition text-sm">✎</span>
        </button>

        {/* Center: action buttons */}
        <div className="flex items-center gap-2">
          <ActionButton
            icon={muted ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zM14.98 11.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>
            )}
            label={muted ? 'Unmute' : 'Mute'}
            active={!muted}
            danger={muted}
            onClick={() => setMuted((m) => !m)}
          />
          <ActionButton
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>}
            label="Camera"
            active={false}
            disabled
          />
          <ActionButton
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>}
            label="Share screen"
            disabled
          />
          <ActionButton
            icon={<div className="w-3 h-3 rounded-full bg-red-500" />}
            label="Record"
            disabled
          />
          <ActionButton
            icon={<span className="text-lg">😊</span>}
            label="Emoji"
            disabled
          />
        </div>

        {/* Right: people / chat / exit */}
        <div className="flex items-center gap-3 text-gray-400">
          <button className="hover:text-white p-2" title="Calendar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z"/></svg>
          </button>
          <button className="hover:text-white p-2 relative" title="Chat">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </button>
          <button className="hover:text-white p-2 flex items-center gap-1" title="People">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            <span className="text-sm">{peers.size + 1}</span>
          </button>
        </div>
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
// Action Button (used in bottom bar)
// ──────────────────────────────────────────────
interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

function ActionButton({ icon, label, active, danger, disabled, onClick }: ActionButtonProps) {
  const base = 'relative w-11 h-11 rounded-full flex items-center justify-center transition group';
  let cls: string;
  if (disabled) cls = `${base} bg-white/5 text-gray-500 cursor-not-allowed`;
  else if (danger) cls = `${base} bg-red-500/20 text-red-400 hover:bg-red-500/30`;
  else if (active) cls = `${base} bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30`;
  else cls = `${base} bg-white/10 text-gray-200 hover:bg-white/20`;
  return (
    <button onClick={disabled ? undefined : onClick} className={cls} title={label}>
      {icon}
      {danger && (
        <span
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          aria-hidden
        >
          <span
            className="block"
            style={{
              width: '70%',
              height: 2,
              background: 'currentColor',
              transform: 'rotate(-45deg)',
              borderRadius: 1,
            }}
          />
        </span>
      )}
    </button>
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
  zoneName?: string | null;
  onClick?: () => void;
  menuOpen?: boolean;
  onWave?: () => void;
  onCloseMenu?: () => void;
}

function Avatar({
  x, y, name, color, isMe, near, showHearingRing, zoneName, onClick, menuOpen, onWave, onCloseMenu,
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
          className="absolute rounded-full border border-white/20 pointer-events-none"
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
        } ${near ? 'ring-2 ring-green-300/70' : isMe ? 'ring-2 ring-blue-300/80' : ''}`}
        style={{ backgroundColor: color }}
      >
        {name[0]?.toUpperCase()}
      </button>

      {/* Gather-style name pill: small, dark bg, green dot prefix */}
      <div
        className="absolute left-1/2 -translate-x-1/2 -bottom-6 flex items-center gap-1 text-[11px] font-medium text-white whitespace-nowrap px-1.5 py-0.5 rounded-full"
        style={{ backgroundColor: 'rgba(20, 25, 40, 0.85)', backdropFilter: 'blur(4px)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="pr-0.5">{name}</span>
      </div>

      {menuOpen && onWave && (
        <>
          {/* Backdrop to close on outside click */}
          <div
            className="fixed inset-0 z-10"
            onClick={(e) => {
              e.stopPropagation();
              onCloseMenu?.();
            }}
          />
          <div
            className="absolute left-1/2 -translate-x-1/2 top-full mt-7 bg-[#1a2030] rounded-2xl shadow-2xl border border-white/10 z-20 w-72 p-4 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center text-white text-2xl font-bold"
                    style={{ backgroundColor: color }}
                  >
                    {name[0]?.toUpperCase()}
                  </div>
                  <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 ring-2 ring-[#1a2030]" />
                </div>
                <div>
                  <div className="text-white font-bold leading-tight">{name}</div>
                  <div className="text-gray-400 text-xs mt-0.5">Available</div>
                </div>
              </div>
              <button className="text-gray-400 hover:text-white p-1" title="More">⋮</button>
            </div>

            <div className="flex items-center gap-1.5 text-gray-400 text-xs mt-2 mb-3">
              <span className="text-pink-400">📍</span>
              <span>{zoneName ?? 'Open floor'}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                onClick={onWave}
                className="bg-indigo-500 hover:bg-indigo-600 text-white font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm"
              >
                <span>👋</span>
                <span>Wave</span>
              </button>
              <button
                disabled
                className="bg-white/5 text-gray-500 font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm cursor-not-allowed"
                title="Coming soon"
              >
                <span>💬</span>
                <span>Message</span>
              </button>
            </div>

            <div className="border-t border-white/10 pt-2 space-y-0.5">
              <MenuItem icon="👤" label="View profile" disabled />
              <MenuItem icon="📍" label="Locate on map" disabled />
              <MenuItem icon="👣" label="Follow" disabled />
              <MenuItem icon="🚪" label="Request to join me" disabled />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ icon, label, disabled }: { icon: string; label: string; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm ${
        disabled ? 'text-gray-500 cursor-not-allowed' : 'text-white hover:bg-white/5'
      }`}
    >
      <span className="w-5 text-center text-gray-400">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
