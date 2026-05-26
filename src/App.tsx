import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';

type CallState = 'idle' | 'calling' | 'incoming' | 'in_call';

interface PeerInfo {
  identity: string;
  name: string;
}

type CallSignal =
  | { type: 'invite'; from: string; fromName: string; to: string }
  | { type: 'accept'; from: string; fromName: string; to: string }
  | { type: 'decline'; from: string; fromName: string; to: string }
  | { type: 'cancel'; from: string; fromName: string; to: string }
  | { type: 'end'; from: string; fromName: string; to: string }
  | { type: 'wave'; from: string; fromName: string; to: string };

// ──────────────────────────────────────────────
// Identity helpers
// ──────────────────────────────────────────────
function getOrCreateIdentity(): string {
  let id = localStorage.getItem('ctt_identity');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('ctt_identity', id);
  }
  return id;
}

// ──────────────────────────────────────────────
// Ring tone (simple Web Audio oscillator)
// ──────────────────────────────────────────────
class Ringer {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private interval: number | null = null;

  start() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.ctx.destination);
    this.osc = this.ctx.createOscillator();
    this.osc.frequency.value = 440;
    this.osc.connect(this.gain);
    this.osc.start();

    // beep pattern: on 0.3s, off 0.3s, repeat
    let on = false;
    this.interval = window.setInterval(() => {
      on = !on;
      if (this.gain) this.gain.gain.value = on ? 0.1 : 0;
    }, 300);
  }

  stop() {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    try {
      this.osc?.stop();
    } catch {}
    this.osc = null;
    this.gain = null;
    this.ctx?.close();
    this.ctx = null;
  }
}

// ──────────────────────────────────────────────
// Main App
// ──────────────────────────────────────────────
export default function App() {
  const [name, setName] = useState<string>(() => localStorage.getItem('ctt_name') || '');
  const [nameInput, setNameInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [callPeer, setCallPeer] = useState<PeerInfo | null>(null);
  const [muted, setMuted] = useState(false);
  const [callStart, setCallStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [waveToast, setWaveToast] = useState<{ name: string; at: number } | null>(null);

  const roomRef = useRef<Room | null>(null);
  const myIdentityRef = useRef<string>(getOrCreateIdentity());
  const callPeerRef = useRef<PeerInfo | null>(null);
  const callStateRef = useRef<CallState>('idle');
  const ringerRef = useRef<Ringer>(new Ringer());
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Keep refs in sync with state
  useEffect(() => {
    callPeerRef.current = callPeer;
  }, [callPeer]);

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  // ──────────────────────────────────────────────
  // Connect to lobby
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!name) return;

    let cancelled = false;
    let room: Room | null = null;

    const connect = async () => {
      try {
        const tokenRes = await fetch(
          `/api/token?identity=${encodeURIComponent(myIdentityRef.current)}&name=${encodeURIComponent(name)}`
        );
        if (!tokenRes.ok) {
          throw new Error(`Token endpoint returned ${tokenRes.status}`);
        }
        const { token, url } = await tokenRes.json();

        room = new Room({
          adaptiveStream: false,
          dynacast: false,
        });

        room.on(RoomEvent.ParticipantConnected, () => updatePeers());
        room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
          updatePeers();
          // If this peer is who I was talking to, end the call
          if (callPeerRef.current?.identity === p.identity) {
            endCallLocally();
          }
        });

        room.on(RoomEvent.DataReceived, (payload, participant) => {
          if (!participant) return;
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload)) as CallSignal;
            if (msg.to !== myIdentityRef.current) return;
            handleSignal(msg);
          } catch (e) {
            console.error('Bad data packet', e);
          }
        });

        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach() as HTMLAudioElement;
            el.id = `audio-${participant.identity}`;
            el.autoplay = true;
            document.body.appendChild(el);
            audioElementsRef.current.set(participant.identity, el);
          }
        });

        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant) => {
          track.detach().forEach((el) => el.remove());
          audioElementsRef.current.delete(participant.identity);
        });

        room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant) => {
          // If we're already in a call with this participant, subscribe to their new audio
          if (
            callStateRef.current === 'in_call' &&
            callPeerRef.current?.identity === participant.identity &&
            pub.kind === Track.Kind.Audio
          ) {
            pub.setSubscribed(true);
          }
        });

        room.on(RoomEvent.Disconnected, () => {
          setConnected(false);
        });

        await room.connect(url, token, { autoSubscribe: false });

        if (cancelled) {
          room.disconnect();
          return;
        }

        // Pre-publish a (disabled) microphone track so others can subscribe later
        // We use the enabled flag to gate audio; track stays published.
        await room.localParticipant.setMicrophoneEnabled(false);

        roomRef.current = room;
        setConnected(true);
        updatePeers();
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
  }, [name]);

  // ──────────────────────────────────────────────
  // Call timer
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (callState !== 'in_call') return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [callState]);

  // Auto-dismiss wave toast after 3s
  useEffect(() => {
    if (!waveToast) return;
    const t = setTimeout(() => setWaveToast(null), 3000);
    return () => clearTimeout(t);
  }, [waveToast]);

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────
  const updatePeers = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    const list: PeerInfo[] = [];
    r.remoteParticipants.forEach((p) => {
      list.push({ identity: p.identity, name: p.name || p.identity });
    });
    setPeers(list);
  }, []);

  const sendSignal = useCallback(async (sig: CallSignal) => {
    const r = roomRef.current;
    if (!r) return;
    const data = new TextEncoder().encode(JSON.stringify(sig));
    await r.localParticipant.publishData(data, { reliable: true });
  }, []);

  const subscribeToPeer = async (peerId: string) => {
    const r = roomRef.current;
    if (!r) return;
    const peer = r.remoteParticipants.get(peerId);
    if (!peer) return;
    peer.audioTrackPublications.forEach((pub) => pub.setSubscribed(true));
  };

  const unsubscribeFromPeer = async (peerId: string) => {
    const r = roomRef.current;
    if (!r) return;
    const peer = r.remoteParticipants.get(peerId);
    if (!peer) return;
    peer.audioTrackPublications.forEach((pub) => pub.setSubscribed(false));
  };

  const startCallAudio = async (peerId: string) => {
    const r = roomRef.current;
    if (!r) return;
    await r.localParticipant.setMicrophoneEnabled(true);
    await subscribeToPeer(peerId);
    setMuted(false);
    setCallState('in_call');
    setCallStart(Date.now());
  };

  const endCallLocally = async () => {
    const r = roomRef.current;
    if (r) {
      await r.localParticipant.setMicrophoneEnabled(false);
      if (callPeerRef.current) {
        await unsubscribeFromPeer(callPeerRef.current.identity);
      }
    }
    ringerRef.current.stop();
    setCallState('idle');
    setCallPeer(null);
    setCallStart(null);
  };

  // ──────────────────────────────────────────────
  // Signal handler
  // ──────────────────────────────────────────────
  const handleSignal = useCallback(
    async (sig: CallSignal) => {
      const r = roomRef.current;
      if (!r) return;

      switch (sig.type) {
        case 'invite': {
          if (callStateRef.current !== 'idle') {
            // I'm busy → auto-decline
            await sendSignal({
              type: 'decline',
              from: myIdentityRef.current,
              fromName: name,
              to: sig.from,
            });
            return;
          }
          setCallPeer({ identity: sig.from, name: sig.fromName });
          setCallState('incoming');
          ringerRef.current.start();
          break;
        }
        case 'accept': {
          if (
            callStateRef.current === 'calling' &&
            callPeerRef.current?.identity === sig.from
          ) {
            ringerRef.current.stop();
            await startCallAudio(sig.from);
          }
          break;
        }
        case 'decline': {
          if (
            callStateRef.current === 'calling' &&
            callPeerRef.current?.identity === sig.from
          ) {
            ringerRef.current.stop();
            setCallState('idle');
            setCallPeer(null);
          }
          break;
        }
        case 'cancel': {
          if (
            callStateRef.current === 'incoming' &&
            callPeerRef.current?.identity === sig.from
          ) {
            ringerRef.current.stop();
            setCallState('idle');
            setCallPeer(null);
          }
          break;
        }
        case 'end': {
          if (
            callStateRef.current === 'in_call' &&
            callPeerRef.current?.identity === sig.from
          ) {
            await endCallLocally();
          }
          break;
        }
        case 'wave': {
          // Someone waved at me — play the wave sound locally
          try {
            const audio = new Audio('/wave.wav');
            audio.volume = 1.0;
            audio.play().catch((e) => console.warn('wave play blocked', e));
          } catch (e) {
            console.warn('wave audio error', e);
          }
          // Optional toast
          setWaveToast({ name: sig.fromName, at: Date.now() });
          break;
        }
      }
    },
    [name, sendSignal]
  );

  // ──────────────────────────────────────────────
  // Actions
  // ──────────────────────────────────────────────
  const onJoin = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    localStorage.setItem('ctt_name', trimmed);
    setName(trimmed);
  };

  const onTalk = async (peer: PeerInfo) => {
    setSelected(null);
    setCallPeer(peer);
    setCallState('calling');
    await sendSignal({
      type: 'invite',
      from: myIdentityRef.current,
      fromName: name,
      to: peer.identity,
    });

    // Auto-cancel after 30s if no response
    const startedFor = peer.identity;
    setTimeout(async () => {
      if (
        callStateRef.current === 'calling' &&
        callPeerRef.current?.identity === startedFor
      ) {
        await sendSignal({
          type: 'cancel',
          from: myIdentityRef.current,
          fromName: name,
          to: startedFor,
        });
        setCallState('idle');
        setCallPeer(null);
      }
    }, 30000);
  };

  const onAccept = async () => {
    if (!callPeer) return;
    await sendSignal({
      type: 'accept',
      from: myIdentityRef.current,
      fromName: name,
      to: callPeer.identity,
    });
    ringerRef.current.stop();
    await startCallAudio(callPeer.identity);
  };

  const onDecline = async () => {
    if (!callPeer) return;
    await sendSignal({
      type: 'decline',
      from: myIdentityRef.current,
      fromName: name,
      to: callPeer.identity,
    });
    ringerRef.current.stop();
    setCallState('idle');
    setCallPeer(null);
  };

  const onCancel = async () => {
    if (!callPeer) return;
    await sendSignal({
      type: 'cancel',
      from: myIdentityRef.current,
      fromName: name,
      to: callPeer.identity,
    });
    setCallState('idle');
    setCallPeer(null);
  };

  const onHangup = async () => {
    if (!callPeer) return;
    await sendSignal({
      type: 'end',
      from: myIdentityRef.current,
      fromName: name,
      to: callPeer.identity,
    });
    await endCallLocally();
  };

  const onWave = async (peer: PeerInfo) => {
    setSelected(null);
    await sendSignal({
      type: 'wave',
      from: myIdentityRef.current,
      fromName: name,
      to: peer.identity,
    });
  };

  const onMuteToggle = async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !muted;
    await r.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  };

  const onChangeName = () => {
    if (callState !== 'idle') return;
    localStorage.removeItem('ctt_name');
    setName('');
    setNameInput('');
  };

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────
  if (!name) {
    return (
      <div className="min-h-screen flex items-center justify-center office-bg">
        <div className="bg-white p-8 rounded-2xl shadow-xl w-96">
          <h1 className="text-3xl font-bold mb-2">Click to Talk</h1>
          <p className="text-gray-600 mb-6">Type a name to join the lobby.</p>
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
            Join
          </button>
        </div>
      </div>
    );
  }

  const duration = callStart ? Math.floor((now - callStart) / 1000) : 0;
  const mm = String(Math.floor(duration / 60)).padStart(2, '0');
  const ss = String(duration % 60).padStart(2, '0');

  const colorFor = (id: string) => {
    const colors = [
      'bg-purple-500',
      'bg-pink-500',
      'bg-orange-500',
      'bg-green-500',
      'bg-cyan-500',
      'bg-indigo-500',
      'bg-rose-500',
      'bg-amber-500',
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return colors[Math.abs(hash) % colors.length];
  };

  return (
    <div className="min-h-screen office-bg p-8">
      <header className="flex items-center justify-between mb-8 max-w-5xl mx-auto bg-black/40 backdrop-blur-sm rounded-2xl px-5 py-3">
        <h1 className="text-2xl font-bold text-white drop-shadow">Click to Talk</h1>
        <div className="flex items-center gap-4 text-gray-200 text-sm">
          {connected ? (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500" /> Connected
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-gray-400" /> Connecting…
            </span>
          )}
          <span>·</span>
          <span>
            You: <span className="font-medium">{name}</span>
          </span>
          <button
            onClick={onChangeName}
            disabled={callState !== 'idle'}
            className="text-blue-500 hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
          >
            change
          </button>
        </div>
      </header>

      {error && (
        <div className="max-w-5xl mx-auto mb-6 bg-red-100 border border-red-300 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap gap-8 justify-center mt-12">
          {/* Me */}
          <div className="flex flex-col items-center">
            <div className="w-24 h-24 rounded-full bg-blue-500 flex items-center justify-center text-white text-3xl font-bold ring-4 ring-blue-200 shadow-lg">
              {name[0]?.toUpperCase()}
            </div>
            <div className="mt-3 text-sm font-semibold text-white drop-shadow-lg bg-blue-600/80 backdrop-blur-sm px-3 py-1 rounded-full">{name} (you)</div>
          </div>

          {peers.map((p) => {
            const inCall = callState === 'in_call' && callPeer?.identity === p.identity;
            return (
              <div key={p.identity} className="flex flex-col items-center relative">
                <button
                  onClick={() => setSelected(selected === p.identity ? null : p.identity)}
                  disabled={callState !== 'idle'}
                  className={`w-24 h-24 rounded-full ${colorFor(p.identity)} flex items-center justify-center text-white text-3xl font-bold hover:scale-110 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg`}
                >
                  {p.name[0]?.toUpperCase()}
                </button>
                <div className="mt-3 text-sm font-semibold text-white drop-shadow-lg bg-black/50 backdrop-blur-sm px-3 py-1 rounded-full">{p.name}</div>
                {inCall && (
                  <div className="mt-1 text-xs text-green-300 font-medium drop-shadow">in call</div>
                )}

                {selected === p.identity && callState === 'idle' && (
                  <div className="absolute top-28 bg-white rounded-xl shadow-2xl p-2 z-10 min-w-40 border border-gray-200 flex flex-col gap-1">
                    <button
                      onClick={() => onTalk(p)}
                      className="w-full px-4 py-2 text-left hover:bg-gray-100 rounded-lg flex items-center gap-2"
                    >
                      <span>🎙</span>
                      <span>Talk</span>
                    </button>
                    <button
                      onClick={() => onWave(p)}
                      className="w-full px-4 py-2 text-left hover:bg-indigo-50 rounded-lg flex items-center gap-2 text-indigo-600"
                    >
                      <span>👋</span>
                      <span>Wave</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {peers.length === 0 && connected && (
          <div className="text-center text-white mt-16 bg-black/50 backdrop-blur-sm rounded-2xl py-8 px-6 max-w-md mx-auto">
            <p className="text-lg">No one else online yet.</p>
            <p className="text-sm mt-2 text-gray-300">
              Open this page in another browser (or share the URL) to talk to someone.
            </p>
          </div>
        )}
      </div>

      {/* Outgoing call */}
      {callState === 'calling' && callPeer && (
        <Overlay>
          <div className="text-center">
            <div
              className={`w-32 h-32 rounded-full ${colorFor(callPeer.identity)} flex items-center justify-center text-white text-5xl font-bold mx-auto mb-4 animate-pulse`}
            >
              {callPeer.name[0]?.toUpperCase()}
            </div>
            <div className="text-gray-500 mb-2">Calling…</div>
            <div className="text-3xl font-bold mb-8">{callPeer.name}</div>
            <button
              onClick={onCancel}
              className="bg-red-500 text-white px-8 py-3 rounded-full hover:bg-red-600 font-semibold transition"
            >
              Cancel
            </button>
          </div>
        </Overlay>
      )}

      {/* Incoming call */}
      {callState === 'incoming' && callPeer && (
        <Overlay>
          <div className="text-center">
            <div
              className={`w-32 h-32 rounded-full ${colorFor(callPeer.identity)} flex items-center justify-center text-white text-5xl font-bold mx-auto mb-4 animate-bounce`}
            >
              {callPeer.name[0]?.toUpperCase()}
            </div>
            <div className="text-gray-500 mb-2">Incoming call from</div>
            <div className="text-3xl font-bold mb-8">{callPeer.name}</div>
            <div className="flex gap-4 justify-center">
              <button
                onClick={onAccept}
                className="bg-green-500 text-white px-8 py-3 rounded-full hover:bg-green-600 font-semibold transition"
              >
                Accept
              </button>
              <button
                onClick={onDecline}
                className="bg-red-500 text-white px-8 py-3 rounded-full hover:bg-red-600 font-semibold transition"
              >
                Decline
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {/* Wave toast */}
      {waveToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-indigo-500 text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-3 z-40 animate-bounce">
          <span className="text-2xl">👋</span>
          <span className="font-medium">{waveToast.name} waved at you</span>
        </div>
      )}

      {/* In-call */}
      {callState === 'in_call' && callPeer && (
        <Overlay>
          <div className="text-center">
            <div
              className={`w-32 h-32 rounded-full ${colorFor(callPeer.identity)} flex items-center justify-center text-white text-5xl font-bold mx-auto mb-4`}
            >
              {callPeer.name[0]?.toUpperCase()}
            </div>
            <div className="text-3xl font-bold">{callPeer.name}</div>
            <div className="text-gray-500 mb-8 font-mono">
              {mm}:{ss}
            </div>
            <div className="flex gap-4 justify-center">
              <button
                onClick={onMuteToggle}
                className={`px-6 py-3 rounded-full font-semibold transition ${
                  muted
                    ? 'bg-yellow-500 text-white hover:bg-yellow-600'
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                {muted ? '🔇 Unmute' : '🎙 Mute'}
              </button>
              <button
                onClick={onHangup}
                className="bg-red-500 text-white px-8 py-3 rounded-full hover:bg-red-600 font-semibold transition"
              >
                End
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl p-10 shadow-2xl min-w-96">{children}</div>
    </div>
  );
}
