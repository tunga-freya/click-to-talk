// John Pork UI bits — capsule button (matches Gather bottom-bar style) +
// the little pig sprite that hovers next to the user's avatar while recording.

interface JohnPorkButtonProps {
  summoned: boolean;
  onClick: () => void;
  durationMs?: number;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

export function JohnPorkButton({ summoned, onClick, durationMs = 0 }: JohnPorkButtonProps) {
  const bg = summoned ? 'bg-red-600 hover:bg-red-500' : 'bg-[#1a2236] hover:bg-[#222b46]';
  const sepBorder = summoned ? 'border-red-800/70' : 'border-white/10';
  const chevronColor = summoned ? 'text-white/90' : 'text-gray-300';
  return (
    <div
      className={`flex items-center h-12 rounded-full ${bg} transition cursor-pointer select-none`}
      onClick={onClick}
      title={summoned ? 'Stop recording (John Pork is watching)' : 'Summon John Pork (start recording)'}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="flex items-center gap-2 h-12 pl-3 pr-3 text-white font-semibold text-[13px]"
      >
        <img
          src="/john-pork.png"
          alt=""
          className="w-7 h-7 rounded-full object-cover bg-white/10"
          style={{ imageRendering: 'auto' }}
        />
        <span>
          {summoned ? `Recording · ${formatDuration(durationMs)}` : 'Summon John Pork'}
        </span>
        {summoned && (
          <span className="ml-1 w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
        )}
      </button>
      <div className={`h-6 border-l ${sepBorder}`} />
      <button
        type="button"
        disabled
        className={`flex items-center justify-center h-12 w-7 ${chevronColor} disabled:cursor-not-allowed`}
        title="Settings (coming soon)"
        onClick={(e) => e.stopPropagation()}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z" />
        </svg>
      </button>
    </div>
  );
}

// Little floating pig that sits next to the user's avatar while recording.
// Positioned in world (image-pixel) space — the world layer's transform
// already scales it correctly to viewport.
export function JohnPorkSprite({
  x,
  y,
  visible,
}: {
  x: number;
  y: number;
  visible: boolean;
}) {
  if (!visible) return null;
  // Float ~50px to the right of the avatar, slightly above
  const left = x + 28;
  const top = y - 26;
  return (
    <div
      className="absolute pointer-events-none select-none"
      style={{
        left,
        top,
        width: 48,
        height: 56,
        transform: 'translate(0, 0)',
        zIndex: 10,
      }}
    >
      <img
        src="/john-pork.png"
        alt="John Pork"
        className="w-full h-full object-contain drop-shadow-lg"
        style={{
          animation: 'jp-bob 1.6s ease-in-out infinite',
        }}
      />
      {/* Tiny REC dot under the pig */}
      <div
        className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[8px] font-bold shadow"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        REC
      </div>
      <style>{`
        @keyframes jp-bob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}
