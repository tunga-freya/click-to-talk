// John Pork recording — self-contained hook + sprite + button.
// Records screen + mixed audio (mic + tab audio) to a low-bitrate WebM,
// downloads it locally, and (if the server has Drive creds) uploads it.

import { useCallback, useEffect, useRef, useState } from 'react';

interface RecorderStreams {
  display?: MediaStream;
  mic?: MediaStream;
  ctx?: AudioContext;
}

export interface UseRecordingResult {
  summoned: boolean;
  recError: string | null;
  recDurationMs: number;
  toggleSummon: () => void;
  // Toast hook so the caller can show "Saved to Drive" etc.
  // (kept simple: an event channel, not a managed-state toast)
  lastDriveUrl: string | null;
}

export function useRecording(name: string): UseRecordingResult {
  const [summoned, setSummoned] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [recStartAt, setRecStartAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [lastDriveUrl, setLastDriveUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<RecorderStreams>({});

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
    const s = streamsRef.current;
    try {
      s.display?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      s.mic?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      s.ctx?.close();
    } catch {}
    streamsRef.current = {};
    recorderRef.current = null;
    setSummoned(false);
    setRecStartAt(null);
  }, []);

  const start = useCallback(async () => {
    setRecError(null);
    let displayStream: MediaStream | null = null;
    let micStream: MediaStream | null = null;
    let ctx: AudioContext | null = null;

    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 12, max: 15 } } as MediaTrackConstraints,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setRecError('Screen capture failed: ' + (err?.message ?? String(e)));
      }
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      console.warn('Mic capture failed, continuing without mic:', e);
    }

    // Mix display + mic audio
    let mixedAudio: MediaStreamTrack | null = null;
    try {
      ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      let hasAudio = false;
      if (displayStream.getAudioTracks().length > 0) {
        ctx
          .createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()))
          .connect(dest);
        hasAudio = true;
      }
      if (micStream && micStream.getAudioTracks().length > 0) {
        ctx
          .createMediaStreamSource(new MediaStream(micStream.getAudioTracks()))
          .connect(dest);
        hasAudio = true;
      }
      if (hasAudio) mixedAudio = dest.stream.getAudioTracks()[0] ?? null;
    } catch (e) {
      console.warn('Audio mix failed:', e);
    }

    const combined = new MediaStream();
    displayStream.getVideoTracks().forEach((t) => combined.addTrack(t));
    if (mixedAudio) combined.addTrack(mixedAudio);

    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
    ];
    const mimeType =
      candidates.find(
        (c) =>
          typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)
      ) ?? 'video/webm';

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 250_000,
        audioBitsPerSecond: 48_000,
      });
    } catch (e: unknown) {
      const err = e as { message?: string };
      setRecError('MediaRecorder failed: ' + (err?.message ?? String(e)));
      displayStream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
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

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `john-pork-${name || 'me'}-${stamp}.webm`;

      // 1) Always download locally
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      // 2) Best-effort Drive upload via resumable session (bypasses Vercel 4.5MB limit)
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
        const { uploadUrl, fileId, viewLink } = await initRes.json();
        // PUT the blob directly to Google's resumable URL (no Vercel limit)
        if (uploadUrl) {
          const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': mimeType },
            body: blob,
          });
          if (putRes.ok) {
            // Drive returns the final file metadata
            const meta = (await putRes.json().catch(() => null)) as
              | { id?: string; webViewLink?: string }
              | null;
            const finalLink =
              meta?.webViewLink ??
              viewLink ??
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

    displayStream.getVideoTracks()[0].addEventListener('ended', () => stop());

    recorder.start(1000);
    recorderRef.current = recorder;
    streamsRef.current = {
      display: displayStream,
      mic: micStream ?? undefined,
      ctx: ctx ?? undefined,
    };
    setSummoned(true);
    setRecStartAt(Date.now());
  }, [name, stop]);

  const toggleSummon = useCallback(() => {
    if (summoned) stop();
    else void start();
  }, [summoned, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recDurationMs = recStartAt ? Date.now() - recStartAt : 0;
  // Reference tick so React re-renders on the interval (otherwise unused)
  void tick;

  return { summoned, recError, recDurationMs, toggleSummon, lastDriveUrl };
}
