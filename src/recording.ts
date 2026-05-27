// John Pork recording — records the LIVE call (LiveKit tracks).
//
// We do NOT prompt for screen capture. Instead we grab whatever the user
// has already published to the room (mic, camera, screen share, screen-share
// audio) and mix it with the audio of every remote peer they're subscribed
// to. The result is a single low-bitrate WebM that captures the actual
// conversation on top of whatever was being shared.
//
// Source priority for the video track:
//   1) the user's own screen-share track (most likely what they want)
//   2) the user's camera
//   3) the first remote screen-share they're subscribed to
//   4) the first remote camera
//   5) audio-only (no video) — file will still play in browsers
//
// Audio is always the FULL mix: local mic + screen-share audio + every
// subscribed remote audio track.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Room, Track } from 'livekit-client';

interface RecorderResources {
  ctx?: AudioContext;
  combined?: MediaStream;
}

export interface UseRecordingResult {
  summoned: boolean;
  recError: string | null;
  recDurationMs: number;
  toggleSummon: () => void;
  lastDriveUrl: string | null;
}

function collectTracksForRecording(room: Room): {
  videoTrack: MediaStreamTrack | null;
  audioTracks: MediaStreamTrack[];
  description: string;
} {
  const lp = room.localParticipant;
  const audioTracks: MediaStreamTrack[] = [];
  let videoTrack: MediaStreamTrack | null = null;
  const bits: string[] = [];

  // Local mic
  const micPub = lp.getTrackPublication(Track.Source.Microphone);
  const micMs = micPub?.track?.mediaStreamTrack;
  if (micMs) {
    audioTracks.push(micMs);
    bits.push('mic');
  }

  // Local screen share (video + its own audio if user picked "share tab audio")
  const ssPub = lp.getTrackPublication(Track.Source.ScreenShare);
  const ssMs = ssPub?.track?.mediaStreamTrack;
  if (ssMs) {
    videoTrack = ssMs;
    bits.push('screen');
  }
  const ssaPub = lp.getTrackPublication(Track.Source.ScreenShareAudio);
  const ssaMs = ssaPub?.track?.mediaStreamTrack;
  if (ssaMs) {
    audioTracks.push(ssaMs);
    bits.push('screen-audio');
  }

  // Local camera (fallback video source if no screen share)
  if (!videoTrack) {
    const camPub = lp.getTrackPublication(Track.Source.Camera);
    const camMs = camPub?.track?.mediaStreamTrack;
    if (camMs) {
      videoTrack = camMs;
      bits.push('camera');
    }
  }

  // Remote tracks
  room.remoteParticipants.forEach((rp) => {
    rp.audioTrackPublications.forEach((pub) => {
      const t = pub.track?.mediaStreamTrack;
      if (t) audioTracks.push(t);
    });
    if (!videoTrack) {
      rp.videoTrackPublications.forEach((pub) => {
        const t = pub.track?.mediaStreamTrack;
        if (!videoTrack && t) {
          videoTrack = t;
          bits.push(`peer-${rp.identity.slice(0, 6)}-video`);
        }
      });
    }
  });

  return { videoTrack, audioTracks, description: bits.join(' + ') || 'nothing' };
}

export function useRecording(
  name: string,
  roomRef: MutableRefObject<Room | null>
): UseRecordingResult {
  const [summoned, setSummoned] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [recStartAt, setRecStartAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [lastDriveUrl, setLastDriveUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const resourcesRef = useRef<RecorderResources>({});

  useEffect(() => {
    if (recStartAt === null) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [recStartAt]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {}
    }
    const r = resourcesRef.current;
    try {
      r.ctx?.close();
    } catch {}
    resourcesRef.current = {};
    recorderRef.current = null;
    setSummoned(false);
    setRecStartAt(null);
  }, []);

  const start = useCallback(async () => {
    setRecError(null);
    const room = roomRef.current;
    if (!room) {
      setRecError('Not connected to a room yet');
      return;
    }

    const { videoTrack, audioTracks, description } = collectTracksForRecording(room);
    if (!videoTrack && audioTracks.length === 0) {
      setRecError(
        'Nothing to record. Turn on your mic, camera, or screen share first.'
      );
      return;
    }

    // Build a mixed audio destination if we have any audio tracks.
    let mixedAudio: MediaStreamTrack | null = null;
    let ctx: AudioContext | null = null;
    if (audioTracks.length > 0) {
      try {
        ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        // De-dupe identical tracks (same MediaStreamTrack instance can show up
        // in both screen-share audio and a remote subscription, theoretically)
        const seen = new Set<string>();
        for (const t of audioTracks) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          try {
            ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
          } catch (e) {
            console.warn('failed to add audio source:', e);
          }
        }
        mixedAudio = dest.stream.getAudioTracks()[0] ?? null;
      } catch (e) {
        console.warn('audio mix setup failed:', e);
      }
    }

    const combined = new MediaStream();
    if (videoTrack) combined.addTrack(videoTrack);
    if (mixedAudio) combined.addTrack(mixedAudio);

    // Pick a MIME type matching what we actually have
    const hasVideo = !!videoTrack;
    const hasAudio = !!mixedAudio;
    const candidates = hasVideo
      ? [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=h264,opus',
          'video/webm',
        ]
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mimeType =
      candidates.find(
        (c) =>
          typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)
      ) ?? (hasVideo ? 'video/webm' : 'audio/webm');

    let recorder: MediaRecorder;
    try {
      const opts: MediaRecorderOptions = {
        mimeType,
        audioBitsPerSecond: 48_000,
      };
      if (hasVideo) opts.videoBitsPerSecond = 250_000;
      recorder = new MediaRecorder(combined, opts);
    } catch (e: unknown) {
      const err = e as { message?: string };
      setRecError('MediaRecorder failed: ' + (err?.message ?? String(e)));
      ctx?.close();
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];

      const ext = hasVideo ? 'webm' : 'webm';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `john-pork-${name || 'me'}-${stamp}.${ext}`;

      // 1) Always download locally
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      // 2) Best-effort Drive upload (resumable URL → direct PUT)
      try {
        const initRes = await fetch('/api/upload-recording', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename,
            mimeType,
            size: blob.size,
            owner: name || 'unknown',
          }),
        });
        if (!initRes.ok) {
          if (initRes.status !== 501)
            console.warn('Drive init failed:', initRes.status, await initRes.text());
          return;
        }
        const { uploadUrl, fileId } = await initRes.json();
        if (uploadUrl) {
          const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': mimeType },
            body: blob,
          });
          if (putRes.ok) {
            const meta = (await putRes.json().catch(() => null)) as
              | { id?: string; webViewLink?: string }
              | null;
            const finalLink =
              meta?.webViewLink ??
              (meta?.id ? `https://drive.google.com/file/d/${meta.id}/view` : null) ??
              (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null);
            if (finalLink) setLastDriveUrl(finalLink);
          } else {
            console.warn('Drive PUT failed:', putRes.status, await putRes.text());
          }
        }
      } catch (e) {
        console.warn('Drive upload error (local file already saved):', e);
      }
    };

    // If the video track ends (e.g. user clicks Stop sharing on the browser pill
    // for their screen share), stop the recording too.
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => stop());
    }

    recorder.start(1000);
    recorderRef.current = recorder;
    resourcesRef.current = { ctx: ctx ?? undefined, combined };
    setSummoned(true);
    setRecStartAt(Date.now());
    console.log(`[john-pork] recording started — sources: ${description}`);
  }, [name, roomRef, stop]);

  const toggleSummon = useCallback(() => {
    if (summoned) stop();
    else void start();
  }, [summoned, start, stop]);

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recDurationMs = recStartAt ? Date.now() - recStartAt : 0;
  void tick;

  return { summoned, recError, recDurationMs, toggleSummon, lastDriveUrl };
}
