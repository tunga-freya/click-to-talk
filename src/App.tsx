import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';
import { useRecording } from './recording';
import { JohnPorkButton, JohnPorkSprite } from './JohnPork';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────
const MAP_W = 2000;
const MAP_H = 925;
const AVATAR_R = 24; // radius px
const HEARING_RADIUS = 65;  // px — open-floor proximity range (where audio drops to zero) — halved per Tunga's request
const HEARING_FULL = 22;    // px — open-floor full-volume range — halved proportionally
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
  dir?: 'left' | 'right';
  walking?: boolean;
}

// ──────────────────────────────────────────────
// Avatar customization
// ──────────────────────────────────────────────
type Skin = 'pale' | 'light' | 'tan' | 'brown' | 'dark';
type HairStyle = 'short' | 'long' | 'bun' | 'bald';
type HatStyle = 'none' | 'cap' | 'beanie';
type TopStyle = 'tshirt' | 'longsleeve' | 'sweater';
type BottomStyle = 'pants' | 'shorts';

interface AvatarConfig {
  skin: Skin;
  hair: string;        // hex
  hairStyle: HairStyle;
  top: string;         // hex
  topStyle: TopStyle;
  bottom: string;      // hex
  bottomStyle: BottomStyle;
  shoes: string;       // hex
  hat: HatStyle;
  hatColor: string;    // hex
}

const SKIN_COLORS: Record<Skin, string> = {
  pale:   '#f5d6b4',
  light:  '#e8b48a',
  tan:    '#c79068',
  brown:  '#8d5c3d',
  dark:   '#523524',
};

const PALETTE = [
  '#ef4444', '#f97316', '#facc15', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e',
  '#ffffff', '#9ca3af', '#1f2937', '#7c2d12', '#fef3c7',
];

const DEFAULT_AVATAR: AvatarConfig = {
  skin: 'light',
  hair: '#3a2419',
  hairStyle: 'short',
  top: '#3b82f6',
  topStyle: 'tshirt',
  bottom: '#1f2937',
  bottomStyle: 'pants',
  shoes: '#171717',
  hat: 'none',
  hatColor: '#1f2937',
};

function loadAvatar(): AvatarConfig {
  try {
    const raw = localStorage.getItem('ctt_avatar');
    if (!raw) return DEFAULT_AVATAR;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_AVATAR, ...parsed };
  } catch {
    return DEFAULT_AVATAR;
  }
}

type Signal =
  | { type: 'pos'; from: string; fromName: string; x: number; y: number; dir: 'left' | 'right'; walking: boolean }
  | { type: 'wave'; from: string; fromName: string; to: string }
  | { type: 'chat'; from: string; fromName: string; text: string; ts: number }
  | { type: 'avatar'; from: string; config: AvatarConfig }
  | { type: 'avatar-req'; from: string }; // ask peers to (re)send their avatar configs

interface ChatMessage {
  id: string;
  from: string;
  fromName: string;
  text: string;
  ts: number;
  mine: boolean;
}

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
  const [myPos, setMyPos] = useState({ x: 1000, y: 400 });

  // Viewport
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });

  // Mic
  const [muted, setMuted] = useState(false);

  // Wave UI
  const [waveToast, setWaveToast] = useState<{ name: string; at: number } | null>(null);
  const [waveMenuFor, setWaveMenuFor] = useState<string | null>(null);

  // Right-side panels (mutually exclusive)
  const [panel, setPanel] = useState<'none' | 'people' | 'chat'>('none');

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatUnread, setChatUnread] = useState(0);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Highlight peer (used by Locate-on-map). Camera fits whole map already, so we
  // just pulse a ring around the target avatar for a few seconds.
  const [highlightPeerId, setHighlightPeerId] = useState<string | null>(null);

  // Avatar customization
  const [myAvatar, setMyAvatar] = useState<AvatarConfig>(() => loadAvatar());
  const [peerAvatars, setPeerAvatars] = useState<Map<string, AvatarConfig>>(new Map());
  const [editorOpen, setEditorOpen] = useState(false);

  // Movement direction + walking flag (for animation + sprite flip)
  const [myDir, setMyDir] = useState<'left' | 'right'>('right');
  const [myWalking, setMyWalking] = useState(false);

  // Camera + screen share
  const [cameraOn, setCameraOn] = useState(false);
  const [screenShareOn, setScreenShareOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  // Video stream URLs per peer (object URLs from MediaStream → HTMLVideoElement attach is done imperatively)
  const [peerCams, setPeerCams] = useState<Set<string>>(new Set());      // who has camera on
  const [peerShares, setPeerShares] = useState<Set<string>>(new Set());  // who is screen-sharing
  // Identity of peer whose screen-share we're currently viewing full-size; null = no viewer
  const [shareViewerPeer, setShareViewerPeer] = useState<string | null>(null);

  // John Pork recording — when summoned, a little pig appears next to me on the
  // map and a low-bitrate webm of the screen + mixed audio is recorded. On stop,
  // the file auto-downloads (and posts to /api/upload-recording for Drive sync
  // if credentials are configured server-side).
  const [summoned, setSummoned] = useState(false);
  const [recStartAt, setRecStartAt] = useState<number | null>(null);
  const [recTick, setRecTick] = useState(0); // forces timer re-render
  const [recError, setRecError] = useState<string | null>(null);

  // ──────────────────────────────────────────────
  // Refs
  // ──────────────────────────────────────────────
  const roomRef = useRef<Room | null>(null);
  const myIdentityRef = useRef<string>(getOrCreateIdentity());

  const heldKeysRef = useRef<Set<string>>(new Set());
  const myPosRef = useRef({ x: 1000, y: 400 });
  const lastBroadcastRef = useRef(0);
  const lastKeepaliveRef = useRef(0);

  const subscribedRef = useRef<Set<string>>(new Set());
  const videoSubsRef = useRef<Set<string>>(new Set()); // peers whose camera/share tracks we're subscribed to

  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const myAvatarRef = useRef<AvatarConfig>(myAvatar);
  useEffect(() => { myAvatarRef.current = myAvatar; }, [myAvatar]);

  const peersRef = useRef<Map<string, PeerInfo>>(new Map());
  useEffect(() => { peersRef.current = peers; }, [peers]);

  const myDirRef = useRef<'left' | 'right'>('right');
  useEffect(() => { myDirRef.current = myDir; }, [myDir]);

  // Local camera preview (bottom-left webcam thumb)
  const selfVideoRef = useRef<HTMLVideoElement>(null);

  // Attach local camera track to the self-preview <video> whenever camera turns on.
  useEffect(() => {
    if (!cameraOn) return;
    const r = roomRef.current;
    const el = selfVideoRef.current;
    if (!r || !el) return;
    const tryAttach = () => {
      for (const pub of r.localParticipant.videoTrackPublications.values()) {
        if (pub.source === Track.Source.Camera && pub.track) {
          pub.track.attach(el);
          return true;
        }
      }
      return false;
    };
    if (!tryAttach()) {
      const t = setTimeout(tryAttach, 200);
      return () => clearTimeout(t);
    }
  }, [cameraOn]);

  // John Pork recording resources (refs so cleanup can find them on unmount)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamsRef = useRef<{ display?: MediaStream; mic?: MediaStream; ctx?: AudioContext }>({});

  // Tick recording timer every second so the badge updates
  useEffect(() => {
    if (recStartAt === null) return;
    const t = window.setInterval(() => setRecTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [recStartAt]);

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
        dir: myDirRef.current,
        walking: heldKeysRef.current.size > 0,
      };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      await r.localParticipant.publishData(data, { reliable: false });
    } catch (e) {
      console.warn('broadcast failed', e);
    }
  }, [name]);

  const broadcastAvatar = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      const msg: Signal = {
        type: 'avatar',
        from: myIdentityRef.current,
        config: myAvatarRef.current,
      };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      await r.localParticipant.publishData(data, { reliable: true });
    } catch (e) {
      console.warn('avatar broadcast failed', e);
    }
  }, []);

  const requestPeerAvatars = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      const msg: Signal = { type: 'avatar-req', from: myIdentityRef.current };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      await r.localParticipant.publishData(data, { reliable: true });
    } catch {}
  }, []);

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
          dir: msg.dir,
          walking: msg.walking,
        });
        return next;
      });
    } else if (msg.type === 'avatar') {
      setPeerAvatars((prev) => {
        const next = new Map(prev);
        next.set(msg.from, msg.config);
        return next;
      });
    } else if (msg.type === 'avatar-req') {
      // Someone (newcomer) wants to see my avatar — send it back
      void broadcastAvatar();
    } else if (msg.type === 'wave') {
      if (msg.to !== myIdentityRef.current) return;
      try {
        const audio = new Audio('/wave.wav');
        audio.volume = 1.0;
        audio.play().catch((e) => console.warn('wave play blocked', e));
      } catch {}
      setWaveToast({ name: msg.fromName, at: Date.now() });
    } else if (msg.type === 'chat') {
      const mine = msg.from === myIdentityRef.current;
      setChatMessages((prev) => [
        ...prev.slice(-99),
        {
          id: `${msg.from}-${msg.ts}-${Math.random().toString(36).slice(2, 6)}`,
          from: msg.from,
          fromName: msg.fromName,
          text: msg.text,
          ts: msg.ts,
          mine,
        },
      ]);
      // unread badge if panel not open + not mine
      if (!mine) {
        setPanel((p) => {
          if (p !== 'chat') setChatUnread((u) => u + 1);
          return p;
        });
      }
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
          // Tell new arrival our position and avatar so they render us correctly
          broadcastPos(myPosRef.current, true);
          broadcastAvatar();
        });

        room.on(RoomEvent.ParticipantDisconnected, (p) => {
          setPeers((prev) => {
            const next = new Map(prev);
            next.delete(p.identity);
            return next;
          });
          setPeerAvatars((prev) => {
            const next = new Map(prev);
            next.delete(p.identity);
            return next;
          });
          setPeerCams((prev) => {
            const next = new Set(prev);
            next.delete(p.identity);
            return next;
          });
          setPeerShares((prev) => {
            const next = new Set(prev);
            next.delete(p.identity);
            return next;
          });
          setShareViewerPeer((cur) => (cur === p.identity ? null : cur));
          subscribedRef.current.delete(p.identity);
          videoSubsRef.current.delete(p.identity);
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

        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
          if (track.kind === Track.Kind.Audio) {
            document
              .querySelectorAll(`audio[data-peer-id="${participant.identity}"]`)
              .forEach((n) => n.remove());

            const el = track.attach() as HTMLAudioElement;
            el.id = `audio-${participant.identity}-${pub.trackSid}`;
            el.dataset.peerId = participant.identity;
            el.autoplay = true;
            el.volume = computeVolumeFor(participant.identity);
            document.body.appendChild(el);
          } else if (track.kind === Track.Kind.Video) {
            // Camera vs screen share are different track sources
            const isShare = pub.source === Track.Source.ScreenShare;
            const wrapId = isShare ? `share-${participant.identity}` : `cam-${participant.identity}`;
            // Remove any orphan
            document.querySelectorAll(`video[data-vid="${wrapId}"]`).forEach((n) => n.remove());
            const el = track.attach() as HTMLVideoElement;
            el.dataset.vid = wrapId;
            el.dataset.peerId = participant.identity;
            el.dataset.kind = isShare ? 'share' : 'cam';
            el.autoplay = true;
            el.muted = true; // audio is in the audio track; avoid double playback
            el.playsInline = true;
            // Hidden source — actual rendering is done by a React <video> with srcObject
            el.style.display = 'none';
            document.body.appendChild(el);
            if (isShare) {
              setPeerShares((prev) => new Set(prev).add(participant.identity));
            } else {
              setPeerCams((prev) => new Set(prev).add(participant.identity));
            }
          }
        });

        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub, participant) => {
          track.detach().forEach((el) => el.remove());
          if (track.kind === Track.Kind.Audio) {
            document
              .querySelectorAll(`audio[data-peer-id="${participant.identity}"]`)
              .forEach((n) => n.remove());
          } else if (track.kind === Track.Kind.Video) {
            const isShare = pub.source === Track.Source.ScreenShare;
            if (isShare) {
              setPeerShares((prev) => {
                const next = new Set(prev); next.delete(participant.identity); return next;
              });
              setShareViewerPeer((cur) => (cur === participant.identity ? null : cur));
            } else {
              setPeerCams((prev) => {
                const next = new Set(prev); next.delete(participant.identity); return next;
              });
            }
          }
        });

        room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant) => {
          // Audio: subscribe if proximity already approved
          if (pub.kind === Track.Kind.Audio && subscribedRef.current.has(participant.identity)) {
            pub.setSubscribed(true);
          }
          // Camera video: subscribe if proximity already approved
          if (pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera &&
              videoSubsRef.current.has(participant.identity)) {
            pub.setSubscribed(true);
          }
          // Screen share: ALWAYS subscribe regardless of proximity (broadcast)
          if (pub.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
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
        // Tell existing peers about my avatar and ask for theirs
        await broadcastAvatar();
        await requestPeerAvatars();
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
  // Shared rule: given my pos and the peer's pos, what volume (0..1) should I hear them at?
  // Rule:
  //  - If EITHER of us is in any zone → only same-zone members hear each other (full volume)
  //  - If both are on open floor → distance attenuation (full inside HEARING_FULL, linear to 0 at HEARING_RADIUS)
  const computeVolumeFor = useCallback((peerId: string): number => {
    const me = myPosRef.current;
    const peer = peersRef.current.get(peerId);
    if (!peer) return 0;
    const myZone = getZoneId(me.x, me.y);
    const peerZone = getZoneId(peer.x, peer.y);
    if (myZone !== null || peerZone !== null) {
      return myZone !== null && myZone === peerZone ? 1.0 : 0.0;
    }
    const d = Math.hypot(me.x - peer.x, me.y - peer.y);
    if (d >= HEARING_RADIUS) return 0;
    if (d <= HEARING_FULL) return 1.0;
    return Math.max(0, 1 - (d - HEARING_FULL) / (HEARING_RADIUS - HEARING_FULL));
  }, []);

  const updateProximityAudio = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;

    let anyoneAudible = false;

    peersRef.current.forEach((_peer, id) => {
      const remote = r.remoteParticipants.get(id);
      if (!remote) return;

      const volume = computeVolumeFor(id);
      const audible = volume > 0;

      // Audio subscription
      const wasAudio = subscribedRef.current.has(id);
      if (audible && !wasAudio) {
        remote.audioTrackPublications.forEach((pub) => pub.setSubscribed(true));
        subscribedRef.current.add(id);
      } else if (!audible && wasAudio) {
        remote.audioTrackPublications.forEach((pub) => pub.setSubscribed(false));
        subscribedRef.current.delete(id);
      }

      // Video subscription (camera) — same proximity rules as audio.
      // Screen share is always-on subscription when published (it's intentional broadcast).
      const wasVideo = videoSubsRef.current.has(id);
      if (audible && !wasVideo) {
        remote.videoTrackPublications.forEach((pub) => pub.setSubscribed(true));
        videoSubsRef.current.add(id);
      } else if (!audible && wasVideo) {
        remote.videoTrackPublications.forEach((pub) => {
          // Keep screen-share subscribed always; unsub only camera tracks
          if (pub.source !== Track.Source.ScreenShare) pub.setSubscribed(false);
        });
        videoSubsRef.current.delete(id);
      }

      if (audible) {
        anyoneAudible = true;
        document
          .querySelectorAll<HTMLAudioElement>(`audio[data-peer-id="${id}"]`)
          .forEach((el) => { el.volume = volume; });
      }
    });

    const want = anyoneAudible && !mutedRef.current;
    if (r.localParticipant.isMicrophoneEnabled !== want) {
      r.localParticipant.setMicrophoneEnabled(want).catch(() => {});
    }
  }, [computeVolumeFor]);

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

      const isWalking = (dx !== 0 || dy !== 0);
      setMyWalking((prev) => (prev === isWalking ? prev : isWalking));

      let moved = false;
      if (isWalking) {
        const len = Math.hypot(dx, dy);
        const nx = clamp(myPosRef.current.x + (dx / len) * SPEED * dt, AVATAR_R, MAP_W - AVATAR_R);
        const ny = clamp(myPosRef.current.y + (dy / len) * SPEED * dt, AVATAR_R, MAP_H - AVATAR_R);

        // Face left or right based on horizontal velocity
        if (dx > 0 && myDirRef.current !== 'right') {
          myDirRef.current = 'right';
          setMyDir('right');
        } else if (dx < 0 && myDirRef.current !== 'left') {
          myDirRef.current = 'left';
          setMyDir('left');
        }

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

  // Chat auto-scroll to bottom on new messages
  useEffect(() => {
    if (panel !== 'chat') return;
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages, panel]);

  // Auto-clear locate-highlight after 4 seconds
  useEffect(() => {
    if (!highlightPeerId) return;
    const t = setTimeout(() => setHighlightPeerId(null), 4000);
    return () => clearTimeout(t);
  }, [highlightPeerId]);

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

  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text) return;
    const r = roomRef.current;
    if (!r) return;
    const ts = Date.now();
    const msg: Signal = {
      type: 'chat',
      from: myIdentityRef.current,
      fromName: name,
      text,
      ts,
    };
    // Echo locally so I see my own message instantly (server doesn't reflect own data)
    setChatMessages((prev) => [
      ...prev.slice(-99),
      { id: `me-${ts}`, from: myIdentityRef.current, fromName: name, text, ts, mine: true },
    ]);
    setChatInput('');
    try {
      const data = new TextEncoder().encode(JSON.stringify(msg));
      await r.localParticipant.publishData(data, { reliable: true });
    } catch (e) {
      console.warn('chat send failed', e);
    }
  }, [chatInput, name]);

  const openPanel = useCallback((p: 'people' | 'chat') => {
    setPanel((cur) => {
      const next = cur === p ? 'none' : p;
      if (next === 'chat') setChatUnread(0);
      return next;
    });
  }, []);

  const locateOnMap = useCallback((peerId: string) => {
    setHighlightPeerId(peerId);
    setPanel('none');
    setWaveMenuFor(null);
  }, []);

  // John Pork recording hook — records the live LiveKit call (no extra prompt)
  const johnPork = useRecording(name, roomRef);

  const toggleCamera = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    setCamError(null);
    const next = !cameraOn;
    try {
      await r.localParticipant.setCameraEnabled(next);
      setCameraOn(next);
    } catch (e: any) {
      console.error('Camera toggle failed', e);
      setCamError(e?.message ?? 'Camera access denied. Check browser permissions.');
      setCameraOn(false);
    }
  }, [cameraOn]);

  const toggleScreenShare = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    setCamError(null);
    const next = !screenShareOn;
    try {
      await r.localParticipant.setScreenShareEnabled(next, { audio: true });
      setScreenShareOn(next);
    } catch (e: any) {
      console.error('Screen share toggle failed', e);
      // User cancelling the picker is not an error worth showing
      if (e?.name !== 'NotAllowedError' || /denied/i.test(String(e?.message))) {
        setCamError(e?.message ?? 'Screen share failed.');
      }
      setScreenShareOn(false);
    }
  }, [screenShareOn]);

  const saveAvatar = useCallback((cfg: AvatarConfig) => {
    setMyAvatar(cfg);
    myAvatarRef.current = cfg;
    try { localStorage.setItem('ctt_avatar', JSON.stringify(cfg)); } catch {}
    void broadcastAvatar();
  }, [broadcastAvatar]);

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

  // Camera: fit the entire office map to the viewport (between top + bottom bars).
  // Scale to fit, then center horizontally + vertically in the available area.
  const TOP_BAR_H = 48;
  const BOTTOM_BAR_H = 64;
  const availW = viewport.w;
  const availH = Math.max(200, viewport.h - TOP_BAR_H - BOTTOM_BAR_H);
  const fitScale = Math.min(availW / MAP_W, availH / MAP_H);
  const camX = (availW - MAP_W * fitScale) / 2;
  const camY = TOP_BAR_H + (availH - MAP_H * fitScale) / 2;

  // Current zone (mine) and occupant counts per zone
  const myZoneId = getZoneId(myPos.x, myPos.y);
  const myZone = getZone(myZoneId);
  const zoneCounts = new Map<string, number>();
  if (myZoneId) zoneCounts.set(myZoneId, 1);
  peers.forEach((p) => {
    const z = getZoneId(p.x, p.y);
    if (z) zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
  });

  // Which peers can I currently hear? (Same rules as proximity audio.)
  // Used to populate the screen-share meeting view's camera column.
  const audiblePeerIds = (() => {
    const s = new Set<string>();
    peers.forEach((p) => {
      const peerZoneId = getZoneId(p.x, p.y);
      if (myZoneId !== null || peerZoneId !== null) {
        if (myZoneId !== null && myZoneId === peerZoneId) s.add(p.identity);
      } else {
        const d = Math.hypot(myPos.x - p.x, myPos.y - p.y);
        if (d < HEARING_RADIUS) s.add(p.identity);
      }
    });
    return s;
  })();

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b1020]">
      {/* World layer */}
      <div
        className="absolute"
        style={{
          width: MAP_W,
          height: MAP_H,
          transform: `translate(${camX}px, ${camY}px) scale(${fitScale})`,
          transformOrigin: '0 0',
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

        {/* My avatar — pixel character with walk animation */}
        <Avatar
          x={myPos.x}
          y={myPos.y}
          name={name + ' (you)'}
          color="#3b82f6"
          isMe
          showHearingRing={!myZoneId}
          avatarCfg={myAvatar}
          dir={myDir}
          walking={myWalking}
          hasCamera={cameraOn}
          isScreenSharing={screenShareOn}
          peerId={myIdentityRef.current}
          onViewScreen={() => setShareViewerPeer(myIdentityRef.current)}
        />

        {/* John Pork sprite — appears next to me while recording */}
        <JohnPorkSprite x={myPos.x} y={myPos.y} visible={johnPork.summoned} />

        {/* Other avatars */}
        {Array.from(peers.values()).map((p) => {
          const d = Math.hypot(myPos.x - p.x, myPos.y - p.y);
          const near = d < HEARING_RADIUS;
          const peerZone = getZone(getZoneId(p.x, p.y));
          const cfg = peerAvatars.get(p.identity) ?? DEFAULT_AVATAR;
          return (
            <Avatar
              key={p.identity}
              x={p.x}
              y={p.y}
              name={p.name}
              color={colorFor(p.identity)}
              near={near}
              zoneName={peerZone?.name ?? null}
              highlight={highlightPeerId === p.identity}
              avatarCfg={cfg}
              dir={p.dir ?? 'right'}
              walking={p.walking ?? false}
              hasCamera={peerCams.has(p.identity)}
              isScreenSharing={peerShares.has(p.identity)}
              peerId={p.identity}
              onClick={() => setWaveMenuFor(waveMenuFor === p.identity ? null : p.identity)}
              menuOpen={waveMenuFor === p.identity}
              onCloseMenu={() => setWaveMenuFor(null)}
              onWave={() => {
                sendWave(p.identity);
                setWaveMenuFor(null);
              }}
              onLocate={() => locateOnMap(p.identity)}
              onViewScreen={() => setShareViewerPeer(p.identity)}
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

      {/* Bottom action bar — Freya pixel-match */}
      <div
        className="absolute bottom-0 left-0 right-0 bg-[#0b1220] flex items-center z-30 text-white"
        style={{ height: 64, paddingLeft: 8, paddingRight: 8, gap: 8 }}
      >
        {/* Far left: Freya logo box */}
        <div
          className="flex-shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #1e3a8a 0%, #172554 100%)' }}
          title="Freya"
        >
          <img src="/freya-logo.svg" alt="Freya" className="w-7 h-7" />
        </div>

        {/* Avatar pill: webcam thumb + name/status + edit pencil */}
        <button
          onClick={() => setEditorOpen(true)}
          className="flex items-center gap-2.5 bg-[#1a2236] hover:bg-[#222b46] h-12 rounded-2xl pl-1.5 pr-3 transition flex-shrink-0"
          title="Customize avatar"
        >
          <div className="relative w-9 h-9 rounded-xl overflow-hidden flex-shrink-0 bg-[#0e1320] flex items-center justify-center">
            {cameraOn ? (
              <video
                ref={selfVideoRef}
                autoPlay
                muted
                playsInline
                className="absolute inset-0 w-full h-full object-cover"
                style={{ transform: 'scaleX(-1)' }}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-white font-bold text-lg" style={{ backgroundColor: colorFor(myIdentityRef.current) }}>{name[0]?.toUpperCase()}</div>
            )}
            <div
              className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-[#1a2236] ${
                connected ? 'bg-green-500' : 'bg-gray-500'
              }`}
            />
          </div>
          <div className="text-left min-w-0">
            <div className="font-semibold text-[13px] leading-tight truncate max-w-[100px]">{name}</div>
            <div className="text-gray-400 text-[12px] leading-tight truncate max-w-[100px]">
              {myZone ? myZone.name : 'Open floor'}
            </div>
          </div>
          <PencilIcon />
        </button>

        {/* Center: action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Mic — teal capsule with chevron */}
          <CapsuleButton
            variant={muted ? 'danger' : 'teal'}
            icon={muted ? <MicMutedIcon /> : <MicIcon />}
            title={muted ? 'Unmute' : 'Mute'}
            onClick={() => setMuted((m) => !m)}
          />

          {/* Camera — teal capsule with chevron (disabled placeholder) */}
          <CapsuleButton
            variant={cameraOn ? 'teal' : 'dark'}
            icon={cameraOn ? <CamIcon /> : <CamMutedIcon />}
            title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
            onClick={toggleCamera}
          />

          {/* Screen share */}
          <CircleButton
            icon={<ScreenShareIcon />}
            title={screenShareOn ? 'Stop sharing screen' : 'Share screen'}
            onClick={toggleScreenShare}
            active={screenShareOn}
          />

          {/* John Pork — start/stop low-bitrate screen + audio recording */}
          <JohnPorkButton
            summoned={johnPork.summoned}
            onClick={johnPork.toggleSummon}
            durationMs={johnPork.recDurationMs}
          />

          {/* Emoji — plain dark circle */}
          <CircleButton
            icon={<EmojiIcon />}
            title="Emoji (coming soon)"
            disabled
          />
        </div>

        {/* Spacer pushes utility cluster to the right */}
        <div className="flex-1" />

        {/* Right: utility */}
        <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
          <IconButton title="Tools (coming soon)" disabled>
            <WrenchIcon />
          </IconButton>
          <IconButton title="Calendar (coming soon)" disabled>
            <CalendarIcon />
          </IconButton>
          <IconButton
            title="Chat"
            active={panel === 'chat'}
            onClick={() => openPanel('chat')}
            badge={chatUnread > 0 && panel !== 'chat' ? (chatUnread > 9 ? '9+' : String(chatUnread)) : undefined}
          >
            <ChatIcon />
          </IconButton>
          <IconButton
            title="People"
            active={panel === 'people'}
            onClick={() => openPanel('people')}
          >
            <PeopleIcon />
            <span className="ml-1 text-[11px] flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              {peers.size + 1}
            </span>
          </IconButton>
          <IconButton title="Leave" onClick={onChangeName} danger>
            <ExitIcon />
          </IconButton>
        </div>
      </div>

      {/* Right-side slide-in panels (People / Chat) */}
      {panel !== 'none' && (
        <SidePanel
          title={panel === 'people' ? `People · ${peers.size + 1}` : 'Chat'}
          onClose={() => setPanel('none')}
          topInset={48 /* TOP_BAR_H */}
          bottomInset={64 /* BOTTOM_BAR_H */}
        >
          {panel === 'people' ? (
            <PeopleList
              self={{ identity: myIdentityRef.current, name, x: myPos.x, y: myPos.y }}
              peers={peers}
              myZoneId={myZoneId}
              onLocate={locateOnMap}
              onWave={(id) => sendWave(id)}
              colorFor={colorFor}
            />
          ) : (
            <ChatView
              messages={chatMessages}
              input={chatInput}
              setInput={setChatInput}
              onSend={sendChat}
              scrollRef={chatScrollRef}
              colorFor={colorFor}
            />
          )}
        </SidePanel>
      )}

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

      {/* Camera permission / share error toast */}
      {camError && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-red-500 text-white px-5 py-3 rounded-lg shadow-2xl flex items-center gap-3 z-40 max-w-md">
          <span>⚠️</span>
          <span className="font-medium text-sm">{camError}</span>
          <button onClick={() => setCamError(null)} className="ml-2 text-white/70 hover:text-white">×</button>
        </div>
      )}

      {/* Local camera preview (PiP) */}
      {cameraOn && (
        <div className="fixed bottom-20 right-4 z-40 w-48 h-36 rounded-xl overflow-hidden bg-black ring-2 ring-emerald-400 shadow-2xl">
          <LocalCameraPreview roomRef={roomRef} />
          <div className="absolute bottom-1 left-1 right-1 text-[10px] text-white/80 text-center bg-black/50 rounded-md px-1 py-0.5">
            You (camera on)
          </div>
        </div>
      )}

      {/* Screen share viewer — Gather-style: left video column + main share area */}
      {shareViewerPeer && (
        <ScreenShareLayout
          sharerPeerId={shareViewerPeer}
          sharerName={
            shareViewerPeer === myIdentityRef.current
              ? name
              : peers.get(shareViewerPeer)?.name ?? 'Someone'
          }
          peers={peers}
          peerCams={peerCams}
          selfName={name}
          selfId={myIdentityRef.current}
          cameraOn={cameraOn}
          muted={muted}
          selfVideoRef={selfVideoRef}
          colorFor={colorFor}
          audiblePeerIds={audiblePeerIds}
          onClose={() => setShareViewerPeer(null)}
        />
      )}

      {/* Avatar editor */}
      {editorOpen && (
        <AvatarEditor
          initial={myAvatar}
          name={name}
          onSave={saveAvatar}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// LocalCameraPreview — attaches local camera track to a <video>
// ──────────────────────────────────────────────
function LocalCameraPreview({ roomRef }: { roomRef: React.RefObject<Room | null> }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const attach = () => {
      const r = roomRef.current;
      if (!r) return;
      const pub = r.localParticipant.getTrackPublication(Track.Source.Camera);
      const track = pub?.track;
      if (track && 'mediaStream' in track) {
        const stream = (track as any).mediaStream as MediaStream | undefined;
        if (stream && target.srcObject !== stream) {
          target.srcObject = stream;
          target.play().catch(() => {});
        }
      }
    };
    attach();
    const id = window.setInterval(attach, 500);
    return () => window.clearInterval(id);
  }, [roomRef]);
  return <video ref={ref} autoPlay muted playsInline className="w-full h-full object-cover" />;
}

// ──────────────────────────────────────────────
// Gather/Freya-matching bottom bar primitives
// ──────────────────────────────────────────────
function GatherLogo() {
  // (kept for backwards compat — not used anymore; FreyaLogo SVG via <img> replaces it)
  return (
    <div className="w-9 h-9 grid grid-cols-2 gap-[3px]" title="Click to Talk">
      <span className="rounded-full bg-indigo-500" />
      <span className="rounded-full bg-indigo-400" />
      <span className="rounded-full bg-indigo-400" />
      <span className="rounded-full bg-indigo-500" />
    </div>
  );
}

type CapsuleVariant = 'teal' | 'dark' | 'danger';

function CapsuleButton({
  icon,
  title,
  variant,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  variant: CapsuleVariant;
  onClick?: () => void;
  disabled?: boolean;
}) {
  // Background per state — picked to visually match Gather's dark teal capsule + the
  // dark navy record capsule + the red muted state.
  let bg = '';
  let mainText = '';
  let chevronText = '';
  let sepBorder = '';
  let hover = '';
  if (variant === 'teal') {
    bg = 'bg-[#0e3d3a]';
    mainText = 'text-emerald-200';
    chevronText = 'text-emerald-300';
    sepBorder = 'border-emerald-900/60';
    hover = 'hover:bg-[#114a45]';
  } else if (variant === 'danger') {
    bg = 'bg-red-600';
    mainText = 'text-white';
    chevronText = 'text-white/90';
    sepBorder = 'border-red-800/70';
    hover = 'hover:bg-red-500';
  } else {
    bg = 'bg-[#1a2236]';
    mainText = 'text-white';
    chevronText = 'text-gray-300';
    sepBorder = 'border-white/10';
    hover = 'hover:bg-[#222b46]';
  }
  const disabledCls = disabled ? 'opacity-60 cursor-not-allowed' : `cursor-pointer ${hover}`;
  return (
    <div className={`flex items-center h-12 rounded-full ${bg} ${disabledCls} transition`}>
      <button
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        className={`flex items-center justify-center h-12 w-11 ${mainText} disabled:cursor-not-allowed`}
        title={title}
      >
        {icon}
      </button>
      <div className={`h-6 border-l ${sepBorder}`} />
      <button
        disabled
        className={`flex items-center justify-center h-12 w-7 ${chevronText} disabled:cursor-not-allowed`}
        title="Settings (coming soon)"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z" />
        </svg>
      </button>
    </div>
  );
}

function CircleButton({
  icon,
  title,
  onClick,
  disabled,
  active,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const base = 'w-12 h-12 rounded-full flex items-center justify-center transition flex-shrink-0';
  let cls: string;
  if (disabled) cls = `${base} bg-[#1a2236] text-gray-400 opacity-60 cursor-not-allowed`;
  else if (active) cls = `${base} bg-emerald-500 text-emerald-950 hover:bg-emerald-400 cursor-pointer`;
  else cls = `${base} bg-[#1a2236] hover:bg-[#222b46] text-white cursor-pointer`;
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cls}
      title={title}
    >
      {icon}
    </button>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-gray-400">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
    </svg>
  );
}

function CamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
    </svg>
  );
}

type CircleState = 'active' | 'danger' | 'neutral';

function ActionCircle({
  icon,
  state,
  title,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  state: CircleState;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const base =
    'w-10 h-10 rounded-full flex items-center justify-center transition flex-shrink-0';
  let cls: string;
  if (disabled) {
    cls = `${base} bg-[#1a2030] text-gray-500 cursor-not-allowed`;
  } else if (state === 'active') {
    cls = `${base} bg-emerald-500 text-emerald-950 hover:bg-emerald-400`;
  } else if (state === 'danger') {
    cls = `${base} bg-red-500 text-white hover:bg-red-400`;
  } else {
    cls = `${base} bg-[#1f2937] text-gray-200 hover:bg-[#2a3346]`;
  }
  return (
    <button onClick={disabled ? undefined : onClick} className={cls} title={title}>
      {icon}
    </button>
  );
}

function SplitButton({ main, chevron }: { main: React.ReactNode; chevron?: boolean }) {
  return (
    <div className="flex items-center">
      {main}
      {chevron && (
        <button
          className="w-5 h-10 -ml-0.5 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/5 rounded-r-md transition"
          title="Settings"
          disabled
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 8l-6 6h12z" />
          </svg>
        </button>
      )}
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
  active,
  danger,
  badge,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  badge?: string;
}) {
  let cls = 'relative h-10 px-2.5 rounded-lg flex items-center transition';
  if (disabled) cls += ' text-gray-600 opacity-50 cursor-not-allowed';
  else if (danger) cls += ' text-red-400 hover:bg-red-500/10';
  else if (active) cls += ' text-white bg-white/10';
  else cls += ' text-gray-400 hover:text-white hover:bg-white/5';
  return (
    <button onClick={disabled ? undefined : onClick} className={cls} title={title}>
      {children}
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Icons (Material-style) ──────────────────
function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
    </svg>
  );
}
function MicMutedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zM14.98 11.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
    </svg>
  );
}
function CamMutedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
    </svg>
  );
}
function ScreenShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4zM4 16V6h16v10.01L4 16zm9-6.87V7h-2v2.13L8.41 11.7l1.41 1.42L12 10.95l2.18 2.17 1.41-1.42L13 9.13z" />
    </svg>
  );
}
function EmojiIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
    </svg>
  );
}
function WrenchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
    </svg>
  );
}
function PeopleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
    </svg>
  );
}
function ExitIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 1.99-.9 1.99-2L21 5c0-1.1-.9-2-2-2z" />
    </svg>
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
  highlight?: boolean;
  showHearingRing?: boolean;
  zoneName?: string | null;
  avatarCfg?: AvatarConfig;
  dir?: 'left' | 'right';
  walking?: boolean;
  hasCamera?: boolean;
  isScreenSharing?: boolean;
  peerId?: string;
  onClick?: () => void;
  menuOpen?: boolean;
  onWave?: () => void;
  onLocate?: () => void;
  onCloseMenu?: () => void;
  onViewScreen?: () => void;
}

function Avatar({
  x, y, name, color, isMe, near, highlight, showHearingRing, zoneName,
  avatarCfg, dir = 'right', walking = false, hasCamera, isScreenSharing, peerId,
  onClick, menuOpen, onWave, onLocate, onCloseMenu, onViewScreen,
}: AvatarProps) {
  return (
    <div
      className="absolute"
      style={{
        left: x - AVATAR_R,
        top: y - AVATAR_R,
        width: AVATAR_R * 2,
        height: AVATAR_R * 2,
        // Local avatar updates every animation frame (60fps) — a CSS transition
        // would be restarted each frame and cause stair-step jitter.
        // Peer avatars get position updates ~12Hz; transition smooths them.
        transition: isMe ? 'none' : 'left 80ms linear, top 80ms linear',
        willChange: 'left, top',
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

      {highlight && (
        <div
          className="absolute rounded-full pointer-events-none animate-ping"
          style={{
            left: -AVATAR_R * 0.5,
            top: -AVATAR_R * 0.5,
            width: AVATAR_R * 3,
            height: AVATAR_R * 3,
            border: '4px solid #fbbf24',
            boxShadow: '0 0 24px #fbbf24',
          }}
        />
      )}

      {/* Video tile above head, or pixel character */}
      {hasCamera && peerId ? (
        <div
          className="absolute left-1/2 -translate-x-1/2 -top-14 w-16 h-12 rounded-md overflow-hidden bg-black ring-2 ring-emerald-400 shadow-lg"
          style={{ pointerEvents: 'none' }}
        >
          <PeerVideo peerId={peerId} kind={isMe ? 'self-cam' : 'cam'} />
        </div>
      ) : null}

      {/* Screen-share indicator badge above head */}
      {isScreenSharing && (
        <button
          onClick={onViewScreen}
          className="absolute left-1/2 -translate-x-1/2 -top-7 px-2 py-0.5 rounded-md text-[10px] font-bold flex items-center gap-1 z-10 bg-emerald-500 text-emerald-950 hover:bg-emerald-400 cursor-pointer"
          title={isMe ? 'Open meeting view (see your share + nearby cameras)' : 'View screen share'}
        >
          📺 {isMe ? 'Sharing — open' : 'View'}
        </button>
      )}

      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={`relative w-full h-full flex items-center justify-center transition ${
          onClick ? 'hover:scale-110 cursor-pointer' : 'cursor-default'
        } ${highlight ? '' : ''}`}
        style={{ background: 'transparent' }}
      >
        {avatarCfg ? (
          <PixelCharacter cfg={avatarCfg} dir={dir} walking={walking} scale={1.1} />
        ) : (
          // Legacy fallback (used by inline avatar pills in editor / menus)
          <div
            className={`w-full h-full rounded-full flex items-center justify-center text-white text-xl font-bold shadow-lg ${
              near ? 'ring-2 ring-green-300/70' : isMe ? 'ring-2 ring-blue-300/80' : ''
            }`}
            style={{ backgroundColor: color }}
          >
            {name[0]?.toUpperCase()}
          </div>
        )}
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
              <MenuItem icon="📍" label="Locate on map" onClick={onLocate} />
              <MenuItem icon="👣" label="Follow" disabled />
              <MenuItem icon="🚪" label="Request to join me" disabled />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm ${
        disabled ? 'text-gray-500 cursor-not-allowed' : 'text-white hover:bg-white/5'
      }`}
    >
      <span className="w-5 text-center text-gray-400">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ──────────────────────────────────────────────
// SidePanel — right-side slide-in for People / Chat
// ──────────────────────────────────────────────
function SidePanel({
  title,
  onClose,
  topInset,
  bottomInset,
  children,
}: {
  title: string;
  onClose: () => void;
  topInset: number;
  bottomInset: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed right-0 w-80 bg-[#0e1320]/95 backdrop-blur border-l border-white/5 flex flex-col z-30 text-white shadow-2xl"
      style={{ top: topInset, bottom: bottomInset }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <h2 className="font-semibold text-sm">{title}</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-xl leading-none w-6 h-6 flex items-center justify-center"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

// ──────────────────────────────────────────────
// PeopleList — directory of self + peers
// ──────────────────────────────────────────────
function PeopleList({
  self,
  peers,
  myZoneId,
  onLocate,
  onWave,
  colorFor,
}: {
  self: { identity: string; name: string; x: number; y: number };
  peers: Map<string, PeerInfo>;
  myZoneId: string | null;
  onLocate: (id: string) => void;
  onWave: (id: string) => void;
  colorFor: (id: string) => string;
}) {
  const rows: Array<{ id: string; name: string; x: number; y: number; zoneId: string | null; mine: boolean }> = [];
  rows.push({ id: self.identity, name: self.name, x: self.x, y: self.y, zoneId: myZoneId, mine: true });
  peers.forEach((p) => rows.push({
    id: p.identity,
    name: p.name,
    x: p.x,
    y: p.y,
    zoneId: getZoneId(p.x, p.y),
    mine: false,
  }));

  return (
    <div className="p-2">
      {rows.map((p) => {
        const zone = getZone(p.zoneId);
        return (
          <div
            key={p.id}
            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5"
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
              style={{ backgroundColor: p.mine ? '#3b82f6' : colorFor(p.id) }}
            >
              {p.name[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {p.name}{p.mine ? ' (you)' : ''}
              </div>
              <div className="text-xs text-gray-400 truncate">
                {zone ? `📍 ${zone.name}` : 'Open floor'}
              </div>
            </div>
            {!p.mine && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => onWave(p.id)}
                  className="px-2 py-1 text-xs rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300"
                  title="Wave"
                >
                  👋
                </button>
                <button
                  onClick={() => onLocate(p.id)}
                  className="px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10 text-gray-300"
                  title="Locate on map"
                >
                  📍
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────
// ChatView — global office chat
// ──────────────────────────────────────────────
function ChatView({
  messages,
  input,
  setInput,
  onSend,
  scrollRef,
  colorFor,
}: {
  messages: ChatMessage[];
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  scrollRef: React.RefObject<HTMLDivElement>;
  colorFor: (id: string) => string;
}) {
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, scrollRef]);

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-gray-500 text-sm text-center mt-8">
            No messages yet. Say hi.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex gap-2 ${m.mine ? 'justify-end' : ''}`}>
            {!m.mine && (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                style={{ backgroundColor: colorFor(m.from) }}
              >
                {m.fromName[0]?.toUpperCase()}
              </div>
            )}
            <div className={`max-w-[75%] ${m.mine ? 'text-right' : ''}`}>
              {!m.mine && (
                <div className="text-[11px] text-gray-400 mb-0.5 px-1">{m.fromName}</div>
              )}
              <div
                className={`inline-block px-3 py-1.5 rounded-2xl text-sm break-words ${
                  m.mine ? 'bg-indigo-500 text-white' : 'bg-white/10 text-white'
                }`}
              >
                {m.text}
              </div>
            </div>
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) onSend();
        }}
        className="border-t border-white/5 p-2 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message everyone…"
          className="flex-1 bg-white/5 border border-white/10 rounded-full px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-indigo-400"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="bg-indigo-500 hover:bg-indigo-600 text-white px-3 rounded-full text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </form>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// PixelCharacter — CSS-rendered 2D human, customizable + animated.
// 32×48 base, scaled. No sprite sheets — pure divs.
// ──────────────────────────────────────────────────────────────
function PixelCharacter({
  cfg,
  dir,
  walking,
  scale = 1,
}: {
  cfg: AvatarConfig;
  dir: 'left' | 'right';
  walking: boolean;
  scale?: number;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!walking) {
      setFrame(0);
      return;
    }
    const id = window.setInterval(() => setFrame((f) => (f + 1) % 4), 140);
    return () => window.clearInterval(id);
  }, [walking]);

  // frame: 0=neutral, 1=left forward, 2=neutral, 3=right forward
  const legSwing = frame === 1 ? -1 : frame === 3 ? 1 : 0;
  const armSwing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const bodyBob = (frame === 1 || frame === 3) ? -1 : 0;

  const skin = SKIN_COLORS[cfg.skin];
  const skinShadow = darken(skin, 0.18);
  const topShadow = darken(cfg.top, 0.25);
  const bottomShadow = darken(cfg.bottom, 0.25);
  const hairShadow = darken(cfg.hair, 0.3);

  // Base box is 32 wide × 48 tall. Scale via transform to keep clean pixels.
  return (
    <div
      style={{
        width: 32 * scale,
        height: 48 * scale,
        position: 'relative',
        transform: dir === 'left' ? `scaleX(-1)` : undefined,
        imageRendering: 'pixelated' as any,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 32,
          height: 48,
          transform: `scale(${scale}) translateY(${bodyBob}px)`,
          transformOrigin: 'top left',
        }}
      >
        {/* Shadow under feet */}
        <div
          style={{
            position: 'absolute',
            left: 8,
            top: 46,
            width: 16,
            height: 3,
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.35)',
            filter: 'blur(0.5px)',
          }}
        />

        {/* Legs */}
        <div
          style={{
            position: 'absolute',
            left: 11,
            top: 36 - legSwing,
            width: 4,
            height: 10 + legSwing,
            background: cfg.bottom,
            borderRight: `1px solid ${bottomShadow}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 17,
            top: 36 + legSwing,
            width: 4,
            height: 10 - legSwing,
            background: cfg.bottom,
            borderRight: `1px solid ${bottomShadow}`,
          }}
        />
        {/* Shoes */}
        <div
          style={{
            position: 'absolute',
            left: 10,
            top: 45 - legSwing,
            width: 6,
            height: 3,
            background: cfg.shoes,
            borderRadius: 1,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 16,
            top: 45 + legSwing,
            width: 6,
            height: 3,
            background: cfg.shoes,
            borderRadius: 1,
          }}
        />

        {/* Body (top / shirt) */}
        <div
          style={{
            position: 'absolute',
            left: 9,
            top: 22,
            width: 14,
            height: 15,
            background: cfg.top,
            borderRadius: '2px 2px 0 0',
            boxShadow: `inset -2px 0 0 ${topShadow}`,
          }}
        />
        {/* Top style accents */}
        {cfg.topStyle === 'sweater' && (
          <div
            style={{
              position: 'absolute',
              left: 9,
              top: 31,
              width: 14,
              height: 2,
              background: topShadow,
            }}
          />
        )}
        {cfg.topStyle === 'longsleeve' && (
          <>
            <div style={{ position: 'absolute', left: 6, top: 24, width: 3, height: 10, background: cfg.top }} />
            <div style={{ position: 'absolute', left: 23, top: 24, width: 3, height: 10, background: cfg.top }} />
          </>
        )}

        {/* Arms (skin) — swing slightly when walking */}
        <div
          style={{
            position: 'absolute',
            left: 6,
            top: 22 + armSwing,
            width: 3,
            height: cfg.topStyle === 'longsleeve' ? 4 : 12,
            background: skin,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 23,
            top: 22 - armSwing,
            width: 3,
            height: cfg.topStyle === 'longsleeve' ? 4 : 12,
            background: skin,
          }}
        />

        {/* Neck */}
        <div
          style={{
            position: 'absolute',
            left: 14,
            top: 20,
            width: 4,
            height: 3,
            background: skinShadow,
          }}
        />

        {/* Head */}
        <div
          style={{
            position: 'absolute',
            left: 10,
            top: 8,
            width: 12,
            height: 13,
            background: skin,
            borderRadius: '3px 3px 4px 4px',
            boxShadow: `inset -2px 0 0 ${skinShadow}`,
          }}
        />

        {/* Eyes */}
        <div style={{ position: 'absolute', left: 13, top: 14, width: 2, height: 2, background: '#1a1a1a' }} />
        <div style={{ position: 'absolute', left: 18, top: 14, width: 2, height: 2, background: '#1a1a1a' }} />

        {/* Mouth */}
        <div style={{ position: 'absolute', left: 14, top: 18, width: 4, height: 1, background: '#5b2f1a', opacity: 0.5 }} />

        {/* Hair */}
        {cfg.hairStyle !== 'bald' && (
          <>
            <div
              style={{
                position: 'absolute',
                left: 9,
                top: 6,
                width: 14,
                height: 6,
                background: cfg.hair,
                borderRadius: '5px 5px 0 0',
                boxShadow: `inset -2px 0 0 ${hairShadow}`,
              }}
            />
            {cfg.hairStyle === 'long' && (
              <div
                style={{
                  position: 'absolute',
                  left: 8,
                  top: 9,
                  width: 16,
                  height: 9,
                  background: cfg.hair,
                  borderRadius: '0 0 6px 6px',
                  boxShadow: `inset -2px 0 0 ${hairShadow}`,
                  zIndex: -1,
                }}
              />
            )}
            {cfg.hairStyle === 'bun' && (
              <div
                style={{
                  position: 'absolute',
                  left: 13,
                  top: 3,
                  width: 6,
                  height: 5,
                  background: cfg.hair,
                  borderRadius: '50%',
                }}
              />
            )}
          </>
        )}

        {/* Hat (on top of hair) */}
        {cfg.hat === 'cap' && (
          <>
            <div
              style={{
                position: 'absolute',
                left: 9,
                top: 4,
                width: 14,
                height: 4,
                background: cfg.hatColor,
                borderRadius: '4px 4px 0 0',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 17,
                top: 7,
                width: 8,
                height: 2,
                background: cfg.hatColor,
              }}
            />
          </>
        )}
        {cfg.hat === 'beanie' && (
          <div
            style={{
              position: 'absolute',
              left: 9,
              top: 3,
              width: 14,
              height: 6,
              background: cfg.hatColor,
              borderRadius: '6px 6px 0 0',
            }}
          />
        )}
      </div>
    </div>
  );
}

function darken(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const r = Math.max(0, Math.round(parseInt(h.slice(0, 2), 16) * (1 - amt)));
  const g = Math.max(0, Math.round(parseInt(h.slice(2, 4), 16) * (1 - amt)));
  const b = Math.max(0, Math.round(parseInt(h.slice(4, 6), 16) * (1 - amt)));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ──────────────────────────────────────────────────────────────
// PeerVideo — renders a remote/local video track into a <video>.
// Pulls the source from the hidden <video data-vid="..."> attached
// by LiveKit's track.attach() in TrackSubscribed.
// ──────────────────────────────────────────────────────────────
function PeerVideo({
  peerId,
  kind,
  className,
}: {
  peerId: string;
  kind: 'cam' | 'share' | 'self-cam' | 'self-share';
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const target = videoRef.current;
    if (!target) return;

    const findAndAttach = () => {
      // For self, look for our own LiveKit local track
      // For peers, find the hidden <video data-vid="...">
      const wantedVid = kind === 'cam' ? `cam-${peerId}`
                     : kind === 'share' ? `share-${peerId}`
                     : kind === 'self-cam' ? `self-cam`
                     : `self-share`;
      const src = document.querySelector<HTMLVideoElement>(`video[data-vid="${wantedVid}"]`);
      if (src && src.srcObject && target.srcObject !== src.srcObject) {
        target.srcObject = src.srcObject;
        target.play().catch(() => {});
      }
    };
    findAndAttach();
    // Re-attach every 500ms in case the source appears late (track publish race)
    const id = window.setInterval(findAndAttach, 500);
    return () => window.clearInterval(id);
  }, [peerId, kind]);

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className={className ?? 'w-full h-full object-cover'}
    />
  );
}

// ──────────────────────────────────────────────────────────────
// AvatarEditor — Gather-style customization modal
// ──────────────────────────────────────────────────────────────
function AvatarEditor({
  initial,
  name,
  onSave,
  onClose,
}: {
  initial: AvatarConfig;
  name: string;
  onSave: (cfg: AvatarConfig) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<AvatarConfig>(initial);
  const [tab, setTab] = useState<'base' | 'clothing' | 'accessories'>('base');
  const [clothingSub, setClothingSub] = useState<'top' | 'bottom'>('top');

  const update = <K extends keyof AvatarConfig>(k: K, v: AvatarConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-[#1a2236] rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl text-white">
        {/* Header with preview */}
        <div className="relative p-6 pb-2 flex flex-col items-center" style={{ background: '#22304b' }}>
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-white/70 hover:text-white text-2xl leading-none px-2"
            title="Close"
          >×</button>
          <div className="absolute top-3 left-3 bg-[#0e1320]/80 px-3 py-1 rounded-md text-sm font-semibold">{name}</div>
          <div className="my-4" style={{ transform: 'scale(2.5)', transformOrigin: 'center' }}>
            <PixelCharacter cfg={cfg} dir="right" walking={false} scale={1} />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/10 px-4">
          {([
            ['base', 'Base'], ['clothing', 'Clothing'], ['accessories', 'Accessories'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${
                tab === id ? 'text-white border-emerald-400' : 'text-gray-400 border-transparent hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-5 max-h-[40vh] overflow-y-auto">
          {tab === 'base' && (
            <>
              <SectionLabel>Skin</SectionLabel>
              <div className="flex gap-2 flex-wrap mb-4">
                {(['pale', 'light', 'tan', 'brown', 'dark'] as Skin[]).map((s) => (
                  <Swatch
                    key={s}
                    color={SKIN_COLORS[s]}
                    selected={cfg.skin === s}
                    onClick={() => update('skin', s)}
                    label={s}
                  />
                ))}
              </div>
              <SectionLabel>Hair Color</SectionLabel>
              <PalettePicker value={cfg.hair} onChange={(v) => update('hair', v)} />
              <SectionLabel>Hair Style</SectionLabel>
              <div className="flex gap-2 flex-wrap mb-2">
                {(['short', 'long', 'bun', 'bald'] as HairStyle[]).map((s) => (
                  <ChipButton key={s} selected={cfg.hairStyle === s} onClick={() => update('hairStyle', s)}>
                    {s}
                  </ChipButton>
                ))}
              </div>
            </>
          )}

          {tab === 'clothing' && (
            <>
              <div className="flex gap-2 mb-4">
                {(['top', 'bottom'] as const).map((s) => (
                  <ChipButton key={s} selected={clothingSub === s} onClick={() => setClothingSub(s)}>
                    {s === 'top' ? 'Top' : 'Bottom'}
                  </ChipButton>
                ))}
              </div>
              {clothingSub === 'top' ? (
                <>
                  <SectionLabel>Top Style</SectionLabel>
                  <div className="flex gap-2 flex-wrap mb-3">
                    {(['tshirt', 'longsleeve', 'sweater'] as TopStyle[]).map((s) => (
                      <ChipButton key={s} selected={cfg.topStyle === s} onClick={() => update('topStyle', s)}>
                        {s}
                      </ChipButton>
                    ))}
                  </div>
                  <SectionLabel>Top Color</SectionLabel>
                  <PalettePicker value={cfg.top} onChange={(v) => update('top', v)} />
                </>
              ) : (
                <>
                  <SectionLabel>Bottom Style</SectionLabel>
                  <div className="flex gap-2 flex-wrap mb-3">
                    {(['pants', 'shorts'] as BottomStyle[]).map((s) => (
                      <ChipButton key={s} selected={cfg.bottomStyle === s} onClick={() => update('bottomStyle', s)}>
                        {s}
                      </ChipButton>
                    ))}
                  </div>
                  <SectionLabel>Bottom Color</SectionLabel>
                  <PalettePicker value={cfg.bottom} onChange={(v) => update('bottom', v)} />
                  <SectionLabel>Shoes Color</SectionLabel>
                  <PalettePicker value={cfg.shoes} onChange={(v) => update('shoes', v)} />
                </>
              )}
            </>
          )}

          {tab === 'accessories' && (
            <>
              <SectionLabel>Hat</SectionLabel>
              <div className="flex gap-2 flex-wrap mb-3">
                {(['none', 'cap', 'beanie'] as HatStyle[]).map((s) => (
                  <ChipButton key={s} selected={cfg.hat === s} onClick={() => update('hat', s)}>
                    {s}
                  </ChipButton>
                ))}
              </div>
              {cfg.hat !== 'none' && (
                <>
                  <SectionLabel>Hat Color</SectionLabel>
                  <PalettePicker value={cfg.hatColor} onChange={(v) => update('hatColor', v)} />
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-white/10 bg-[#161e2f]">
          <button
            onClick={onClose}
            className="bg-[#2a334a] hover:bg-[#36405d] text-white font-medium px-6 py-2.5 rounded-lg text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => { onSave(cfg); onClose(); }}
            className="bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold px-6 py-2.5 rounded-lg text-sm"
          >
            Finish Editing
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs uppercase tracking-wide text-gray-400 font-semibold mt-1 mb-2">{children}</div>;
}

function Swatch({
  color, selected, onClick, label,
}: { color: string; selected: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-8 h-8 rounded-full border-2 transition ${
        selected ? 'border-white scale-110' : 'border-transparent hover:border-white/40'
      }`}
      style={{ backgroundColor: color }}
    />
  );
}

function PalettePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2 flex-wrap mb-4">
      {PALETTE.map((c) => (
        <Swatch key={c} color={c} selected={value.toLowerCase() === c.toLowerCase()} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function ChipButton({
  selected, onClick, children,
}: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
        selected ? 'bg-white text-[#0e1320]' : 'bg-[#2a334a] text-gray-300 hover:bg-[#36405d]'
      }`}
    >
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────
// ScreenShareLayout — Gather-style: left video column + main share area.
// Top bar (48px) + Bottom bar (64px) remain visible above/below.
// ──────────────────────────────────────────────────────────────
function ScreenShareLayout({
  sharerPeerId,
  sharerName,
  peers,
  peerCams,
  selfName,
  selfId,
  cameraOn,
  muted,
  selfVideoRef,
  colorFor,
  onClose,
  audiblePeerIds,
}: {
  sharerPeerId: string;
  sharerName: string;
  peers: Map<string, PeerInfo>;
  peerCams: Set<string>;
  selfName: string;
  selfId: string;
  cameraOn: boolean;
  muted: boolean;
  selfVideoRef: React.RefObject<HTMLVideoElement>;
  colorFor: (id: string) => string;
  onClose: () => void;
  audiblePeerIds: Set<string>;
}) {
  // Show only peers I can hear (same zone or within hearing range) — those are
  // the participants in this "meeting". Always include the sharer even if they
  // aren't audible (e.g. you opened the share from far away).
  const peerList = Array.from(peers.values()).filter(
    (p) => audiblePeerIds.has(p.identity) || p.identity === sharerPeerId
  );

  return (
    <div
      className="fixed left-0 right-0 z-40 flex"
      style={{ top: 48, bottom: 64 }}
    >
      {/* Left video column */}
      <div className="w-[140px] flex-shrink-0 bg-[#0b1220] p-2 flex flex-col gap-2 overflow-y-auto border-r border-white/5">
        {/* Self tile */}
        <ShareTile
          name={selfName}
          color={colorFor(selfId)}
          cameraOn={cameraOn}
          muted={muted}
          isMe
          selfVideoRef={selfVideoRef}
        />
        {/* Peer tiles */}
        {peerList.map((p) => (
          <ShareTile
            key={p.identity}
            peerId={p.identity}
            name={p.name}
            color={colorFor(p.identity)}
            cameraOn={peerCams.has(p.identity)}
          />
        ))}
      </div>

      {/* Main share area */}
      <div className="flex-1 bg-[#0a0d14] relative flex items-center justify-center">
        {/* Header strip */}
        <div className="absolute top-0 left-0 right-0 px-4 py-2 bg-black/40 backdrop-blur-sm text-white flex items-center justify-between text-sm pointer-events-none z-10">
          <div className="flex items-center gap-2">
            <span>📺</span>
            <span className="font-medium">
              {sharerPeerId === selfId ? 'Your screen' : `${sharerName}'s screen`}
            </span>
          </div>
          <button
            onClick={onClose}
            className="pointer-events-auto text-gray-300 hover:text-white px-3 py-1 rounded-md hover:bg-white/10 text-xs"
            title="Hide share viewer (does not stop the share)"
          >
            Hide
          </button>
        </div>
        {sharerPeerId === selfId ? (
          /* Self-share preview — we don't show the actual capture (avoid loop) but show a clean placeholder + remind user share is live */
          <div className="flex flex-col items-center justify-center text-white/70 text-center px-8">
            <div className="text-6xl mb-3">📺</div>
            <div className="font-semibold mb-1">You're sharing your screen</div>
            <div className="text-sm text-white/50">
              Nearby people see it. Their cameras appear on the left.
            </div>
          </div>
        ) : (
          <PeerVideo
            peerId={sharerPeerId}
            kind="share"
            className="max-w-full max-h-full object-contain"
          />
        )}
      </div>
    </div>
  );
}

// One participant tile in the left column of the screen-share layout.
function ShareTile({
  peerId,
  name,
  color,
  cameraOn,
  muted,
  isMe,
  selfVideoRef,
}: {
  peerId?: string;
  name: string;
  color: string;
  cameraOn: boolean;
  muted?: boolean;
  isMe?: boolean;
  selfVideoRef?: React.RefObject<HTMLVideoElement>;
}) {
  return (
    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-[#0e1320] flex items-center justify-center">
      {cameraOn ? (
        isMe ? (
          <video
            ref={selfVideoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />
        ) : (
          peerId && (
            <PeerVideo
              peerId={peerId}
              kind="cam"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )
        )
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center text-white text-xl font-bold"
          style={{ backgroundColor: color }}
        >
          {name[0]?.toUpperCase()}
        </div>
      )}
      {/* Name label */}
      <div className="absolute left-1.5 bottom-1.5 flex items-center gap-1 bg-black/55 backdrop-blur px-1.5 py-0.5 rounded-md text-white text-[10px] font-medium">
        {muted && <span>🔇</span>}
        <span className="truncate max-w-[100px]">{name}{isMe ? ' (you)' : ''}</span>
      </div>
    </div>
  );
}
