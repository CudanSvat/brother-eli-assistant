import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { DeskBackground, RevealBanner, TitleBlock } from "./components/Desk";
import { C, fonts, type WheelProps } from "./theme";

export const StampPress: React.FC<WheelProps> = ({
  title,
  subtitle,
  players,
  winner,
  prizeLine,
  hasWinner,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const candidates = (players.length ? players : ["Eli #1", "Eli #2", "Eli #3"]).slice(0, 8);
  // Slam sequence: each candidate gets a stamp beat, then final winner stamp
  const beat = 14;
  const start = 28;
  const finalBeat = start + candidates.length * beat + 10;

  const stamps = candidates.map((label, i) => {
    const t0 = start + i * beat;
    const slam = interpolate(frame, [t0, t0 + 4, t0 + 10], [0, 1.15, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const op = interpolate(frame, [t0, t0 + 3, t0 + beat - 2, t0 + beat], [0, 1, 1, 0.25], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return { label, slam, op, x: 180 + (i % 4) * 180, y: 280 + Math.floor(i / 4) * 160 };
  });

  const finalSlam = interpolate(frame, [finalBeat, finalBeat + 6, finalBeat + 16], [0, 1.2, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const finalOp = interpolate(frame, [finalBeat, finalBeat + 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const revealStart = finalBeat + 24;
  const winnerOp = interpolate(frame, [revealStart, revealStart + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const winnerScale = spring({
    frame: Math.max(0, frame - revealStart),
    fps,
    from: 0.55,
    to: 1,
    durationInFrames: 18,
  });
  const titleOp = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });

  // Press head
  const pressY = (() => {
    for (let i = 0; i < candidates.length; i++) {
      const t0 = start + i * beat;
      if (frame >= t0 && frame < t0 + 8) {
        return interpolate(frame, [t0, t0 + 3, t0 + 8], [-80, 40, -60], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
      }
    }
    if (frame >= finalBeat && frame < finalBeat + 12) {
      return interpolate(frame, [finalBeat, finalBeat + 4, finalBeat + 12], [-80, 60, -40], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    }
    return -70;
  })();

  return (
    <DeskBackground>
      <AbsoluteFill style={{ paddingTop: 40 }}>
        <div style={{ opacity: titleOp }}>
          <TitleBlock title={title} subtitle={subtitle} />
        </div>

        {/* Mint press head */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 160,
            transform: `translateX(-50%) translateY(${pressY}px)`,
            width: 200,
            height: 90,
            background: C.ink,
            borderRadius: 8,
            boxShadow: "5px 6px 0 rgba(17,18,15,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: fonts.elite,
            color: C.gold,
            fontSize: 22,
            letterSpacing: 3,
            zIndex: 6,
          }}
        >
          PRESS
        </div>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 140,
            width: 24,
            height: 120,
            marginLeft: -12,
            background: C.rule,
            zIndex: 5,
            transform: `translateY(${Math.min(0, pressY)}px)`,
          }}
        />

        {/* Candidate stamps */}
        {stamps.map((s, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: s.x,
              top: s.y,
              opacity: s.op,
              transform: `scale(${s.slam}) rotate(${(i % 2 === 0 ? -1 : 1) * 4}deg)`,
              padding: "14px 18px",
              border: `3px solid ${C.cobalt}`,
              color: C.cobalt,
              fontFamily: fonts.elite,
              fontSize: 22,
              textTransform: "uppercase",
              background: "rgba(239,233,220,0.85)",
            }}
          >
            {s.label}
          </div>
        ))}

        {/* Final stamp */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 520,
            opacity: finalOp,
            transform: `translateX(-50%) scale(${finalSlam}) rotate(-3deg)`,
            padding: "28px 36px",
            border: `5px solid ${hasWinner ? C.negative : C.ink}`,
            color: hasWinner ? C.negative : C.ink,
            fontFamily: fonts.elite,
            fontSize: 40,
            letterSpacing: 3,
            textTransform: "uppercase",
            background: C.paperSunk,
            boxShadow: "6px 7px 0 rgba(17,18,15,0.35)",
            textAlign: "center",
            zIndex: 4,
          }}
        >
          <div style={{ fontSize: 18, marginBottom: 8 }}>{hasWinner ? "CERTIFIED" : "VOID"}</div>
          {winner}
        </div>

        <div style={{ position: "absolute", bottom: 36, width: "100%" }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <RevealBanner
              hasWinner={hasWinner}
              winner={winner}
              prizeLine={prizeLine}
              opacity={winnerOp}
              scale={winnerScale}
            />
          </div>
        </div>
      </AbsoluteFill>
    </DeskBackground>
  );
};
