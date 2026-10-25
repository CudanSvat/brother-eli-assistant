import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export interface WheelOfFortuneProps {
  title: string;
  subtitle: string;
  players: string[];
  winner: string;
  prizeLine: string;
  hasWinner: boolean;
}

const BG = "#0c1220";
const GOLD = "#f5d031";
const COBALT = "#1a66c4";
const GREEN = "#5dff9a";
const RED = "#ff6b6b";
const WHITE = "#f0f4fa";
const DIM = "#7a8799";
const DARK_CARD = "#121a2b";

const Glow: React.FC<{
  color: string;
  size?: number;
  opacity?: number;
  x?: number;
  y?: number;
}> = ({ color, size = 300, opacity = 0.3, x = 0, y = 0 }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: size,
      height: size,
      borderRadius: "50%",
      background: `radial-gradient(circle, ${color} 0%, transparent 70%)`,
      opacity,
      filter: "blur(40px)",
    }}
  />
);

export const WheelOfFortune: React.FC<WheelOfFortuneProps> = ({
  title,
  subtitle,
  players,
  winner,
  prizeLine,
  hasWinner,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const seededShuffle = (arr: string[], seed: number): string[] => {
    const result = [...arr];
    let s = seed;
    for (let i = result.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      const j = (s >>> 0) % (i + 1);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };

  const list = players.length ? players : ["Eli #1", "Eli #2", "Eli #3"];
  const reelNames: string[] = [];
  const totalSlots = list.length * 6 + list.length;
  for (let rot = 0; rot < Math.ceil(totalSlots / list.length); rot++) {
    const shuffled = seededShuffle(list, rot * 7 + 42);
    for (const name of shuffled) {
      if (reelNames.length < totalSlots) reelNames.push(name);
    }
  }
  reelNames.push(winner);
  const winnerIndex = reelNames.length - 1;
  const afterNames = seededShuffle(list, 999);
  const extraCount = Math.max(8, list.length * 2);
  for (let i = 0; i < extraCount; i++) {
    reelNames.push(afterNames[i % afterNames.length]!);
  }

  const SLOT_HEIGHT = 70;
  const SPIN_START = 25;
  const SPIN_END = 155;
  const revealStart = 160;
  const viewportHeight = 630;
  const viewportCenter = viewportHeight / 2;

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const titleY = interpolate(frame, [0, 25], [40, 0], { extrapolateRight: "clamp" });
  const titleScale = spring({ frame, fps, from: 0.8, to: 1, durationInFrames: 30 });

  const spinProgress = interpolate(frame, [SPIN_START, SPIN_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const easedProgress = 1 - Math.pow(1 - spinProgress, 3);
  const targetOffset = winnerIndex * SLOT_HEIGHT;
  const reelOffset = easedProgress * targetOffset;

  const winnerOpacity = interpolate(frame, [revealStart, revealStart + 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const winnerScale = spring({
    frame: Math.max(0, frame - revealStart),
    fps,
    from: 0.5,
    to: 1,
    durationInFrames: 20,
  });
  const winnerGlow = interpolate(
    frame,
    [revealStart, revealStart + 20, revealStart + 30],
    [0, 1, 0.7],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const celebrationPulse =
    frame > revealStart + 20 ? interpolate(frame % 15, [0, 7, 15], [1, 1.05, 1]) : 1;

  const arrowGlow =
    frame >= SPIN_START && frame <= SPIN_END
      ? interpolate(frame % 6, [0, 3, 6], [0.6, 1, 0.6])
      : 0.8;

  const accent = hasWinner ? GREEN : RED;
  const revealTitle = hasWinner ? "WINNER" : "NO WINNER";

  const confetti =
    frame > revealStart && hasWinner
      ? Array.from({ length: 30 }, (_, i) => {
          const startX = 540 + (i % 2 === 0 ? 1 : -1) * ((i * 73) % 400);
          const x = startX + Math.sin((frame - revealStart + i * 50) * 0.05) * 30;
          const y = -20 + (frame - revealStart) * (2 + (i % 4) * 1.5);
          const rotation = (frame - revealStart + i * 30) * 3;
          const colors = [GOLD, COBALT, GREEN, "#8b5cf6", "#f472b6", WHITE];
          return {
            x,
            y,
            rotation,
            color: colors[i % colors.length]!,
            size: 6 + (i % 4) * 3,
            opacity:
              y > 1100
                ? 0
                : interpolate(frame - revealStart, [0, 10], [0, 0.9], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
          };
        })
      : [];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: BG,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <Glow color={GOLD} size={500} opacity={0.08} x={-100} y={-100} />
      <Glow color={COBALT} size={480} opacity={0.12} x={700} y={600} />
      {frame > revealStart && (
        <Glow color={accent} size={600} opacity={0.12 * winnerOpacity} x={240} y={300} />
      )}

      <div
        style={{
          position: "absolute",
          top: 60,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          opacity: titleOpacity,
          transform: `translateY(${titleY}px) scale(${titleScale})`,
        }}
      >
        <div
          style={{
            fontSize: 22,
            color: DIM,
            letterSpacing: 6,
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          $SLAY
        </div>
        <div
          style={{
            fontSize: 52,
            fontWeight: 900,
            color: GOLD,
            textAlign: "center",
            textShadow: `0 0 20px ${GOLD}44`,
            padding: "0 48px",
            lineHeight: 1.1,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 20, color: DIM, marginTop: 8 }}>{subtitle}</div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 240,
          left: "50%",
          transform: "translateX(-50%)",
          width: 600,
          height: viewportHeight,
          overflow: "hidden",
          borderRadius: 16,
          border: `1px solid ${DIM}33`,
          background: `linear-gradient(180deg, ${BG} 0%, ${DARK_CARD} 50%, ${BG} 100%)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 150,
            background: `linear-gradient(180deg, ${BG} 0%, transparent 100%)`,
            zIndex: 10,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 150,
            background: `linear-gradient(0deg, ${BG} 0%, transparent 100%)`,
            zIndex: 10,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: viewportCenter - SLOT_HEIGHT / 2 - 4,
            left: 0,
            right: 0,
            height: SLOT_HEIGHT + 8,
            background: `linear-gradient(90deg, transparent, ${GOLD}15, transparent)`,
            borderTop: `2px solid ${GOLD}66`,
            borderBottom: `2px solid ${GOLD}66`,
            zIndex: 5,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "relative",
            transform: `translateY(${viewportCenter - SLOT_HEIGHT / 2 - reelOffset}px)`,
          }}
        >
          {reelNames.map((name, i) => {
            const slotY = i * SLOT_HEIGHT;
            const distFromCenter = Math.abs(slotY - reelOffset);
            const isCenter = distFromCenter < SLOT_HEIGHT / 2;
            const dimFactor = interpolate(
              distFromCenter,
              [0, SLOT_HEIGHT * 2, SLOT_HEIGHT * 4],
              [1, 0.5, 0.2],
              { extrapolateRight: "clamp" },
            );
            return (
              <div
                key={i}
                style={{
                  height: SLOT_HEIGHT,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: isCenter ? 36 : 28,
                  fontWeight: isCenter ? 800 : 500,
                  color: isCenter && frame >= SPIN_END ? GOLD : WHITE,
                  opacity: dimFactor,
                  textTransform: "uppercase",
                  letterSpacing: isCenter ? 2 : 1,
                }}
              >
                {name}
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 240 + viewportCenter - 15,
          left: "50%",
          transform: "translateX(-50%)",
          width: 640,
          display: "flex",
          justifyContent: "space-between",
          zIndex: 20,
          opacity: arrowGlow,
        }}
      >
        <div style={{ fontSize: 30, color: GOLD, filter: `drop-shadow(0 0 8px ${GOLD})` }}>▶</div>
        <div style={{ fontSize: 30, color: GOLD, filter: `drop-shadow(0 0 8px ${GOLD})` }}>◀</div>
      </div>

      {frame >= revealStart && (
        <div
          style={{
            position: "absolute",
            bottom: 60,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            opacity: winnerOpacity,
            transform: `scale(${winnerScale * celebrationPulse})`,
          }}
        >
          <div
            style={{
              fontSize: 28,
              color: accent,
              fontWeight: 900,
              letterSpacing: 4,
              textShadow: `0 0 ${20 * winnerGlow}px ${accent}`,
            }}
          >
            {revealTitle}
          </div>
          <div
            style={{
              fontSize: 44,
              fontWeight: 900,
              color: GOLD,
              textTransform: "uppercase",
              textShadow: `0 0 ${30 * winnerGlow}px ${GOLD}`,
              letterSpacing: 3,
            }}
          >
            {winner}
          </div>
          <div style={{ fontSize: 22, color: DIM, marginTop: 4 }}>{prizeLine}</div>
        </div>
      )}

      {confetti.map((c, i) => (
        <div
          key={`c${i}`}
          style={{
            position: "absolute",
            left: c.x,
            top: c.y,
            width: c.size,
            height: c.size * 0.6,
            backgroundColor: c.color,
            opacity: c.opacity,
            transform: `rotate(${c.rotation}deg)`,
            borderRadius: 2,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};
