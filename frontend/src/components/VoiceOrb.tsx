export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "offline";

const STATE_LABEL: Record<OrbState, string> = {
  idle: "Standing by",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Responding",
  offline: "AI offline",
};

/**
 * The JARVIS "arc" visualisation. Pure CSS/SVG so it stays cheap; animation
 * intensity reflects assistant state. Phase 4 feeds live microphone levels
 * into `level` (0..1) for the listening state.
 */
export function VoiceOrb({
  state = "idle",
  size = 160,
  level = 0,
  showLabel = false,
}: {
  state?: OrbState;
  size?: number;
  level?: number;
  showLabel?: boolean;
}) {
  const active = state === "thinking" || state === "speaking" || state === "listening";
  const coreScale = state === "listening" ? 1 + Math.min(level, 1) * 0.35 : 1;
  const hue = state === "offline" ? "text-ink-faint" : "text-arc";

  return (
    <div className="flex flex-col items-center gap-3" role="img" aria-label={`Assistant status: ${STATE_LABEL[state]}`}>
      <div className={`relative ${hue}`} style={{ width: size, height: size }} data-state={state}>
        {/* glow */}
        <div
          className={`absolute inset-[18%] rounded-full bg-current blur-2xl transition-opacity duration-500 ${
            active ? "opacity-40" : "opacity-15"
          }`}
        />
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full">
          <defs>
            <radialGradient id="orb-core" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="#ecfeff" />
              <stop offset="45%" stopColor="currentColor" />
              <stop offset="100%" stopColor="#083344" />
            </radialGradient>
          </defs>
          <g className="origin-center animate-orb-spin" style={{ transformBox: "fill-box" }}>
            <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 6" />
          </g>
          <g
            className={`origin-center ${active ? "animate-orb-spin" : "animate-orb-spin-rev"}`}
            style={{ transformBox: "fill-box", animationDuration: active ? "3.5s" : undefined }}
          >
            <circle cx="100" cy="100" r="76" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="2" strokeDasharray="70 40 12 40" strokeLinecap="round" />
          </g>
          <g className="origin-center animate-orb-spin-rev" style={{ transformBox: "fill-box" }}>
            <circle cx="100" cy="100" r="62" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="6" strokeDasharray="1 7" />
          </g>
        </svg>
        <div
          className={`absolute inset-[34%] rounded-full shadow-[0_0_40px_currentColor] transition-transform duration-150 ${
            state === "thinking" ? "animate-orb-pulse" : active ? "" : "animate-orb-breathe"
          }`}
          style={{ background: "radial-gradient(circle at 50% 42%, #ecfeff 0%, currentColor 45%, #083344 100%)", transform: `scale(${coreScale})` }}
        />
        {state === "speaking" && <SpeakingBars />}
      </div>
      {showLabel && <span className="text-xs font-medium tracking-[0.2em] text-ink-dim uppercase">{STATE_LABEL[state]}</span>}
    </div>
  );
}

function SpeakingBars() {
  return (
    <div className="absolute inset-x-0 -bottom-1 flex justify-center gap-1" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="h-3 w-1 rounded-full bg-arc animate-orb-pulse"
          style={{ animationDelay: `${i * 0.12}s`, animationDuration: "0.7s" }}
        />
      ))}
    </div>
  );
}
