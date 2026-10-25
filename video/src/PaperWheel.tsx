import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { DeskBackground, RevealBanner, TitleBlock } from "./components/Desk";
import { C, fonts, type WheelProps } from "./theme";

const SEGMENTS = 12;

export const PaperWheel: React.FC<WheelProps> = ({
  title,
  subtitle,
  players,
  winner,
  prizeLine,
  hasWinner,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const labels: string[] = [];
  const base = players.length ? players : ["Eli #1", "Eli #2", "Eli #3"];
  for (let i = 0; i < SEGMENTS - 1; i++) labels.push(base[i % base.length]!);
  labels.push(winner);

  const winnerSeg = SEGMENTS - 1;
  const segAngle = 360 / SEGMENTS;
  // Pointer at top ( -90deg in standard math). Land winner center under pointer.
  const targetRot = 360 * 5 + (270 - (winnerSeg * segAngle + segAngle / 2));

  const SPIN_START = 20;
  const SPIN_END = 160;
  const revealStart = 168;
  const t = interpolate(frame, [SPIN_START, SPIN_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eased = 1 - Math.pow(1 - t, 3);
  const rotation = eased * targetRot;

  const titleOp = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const winnerOp = interpolate(frame, [revealStart, revealStart + 14], [0, 1], {
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

  const size = 720;
  const r = size / 2;

  return (
    <DeskBackground>
      <AbsoluteFill style={{ paddingTop: 40, alignItems: "center" }}>
        <div style={{ opacity: titleOp }}>
          <TitleBlock title={title} subtitle={subtitle} />
        </div>

        <div
          style={{
            marginTop: 28,
            width: size,
            height: size,
            position: "relative",
          }}
        >
          {/* Pointer */}
          <div
            style={{
              position: "absolute",
              top: -8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 5,
              width: 0,
              height: 0,
              borderLeft: "18px solid transparent",
              borderRight: "18px solid transparent",
              borderTop: `36px solid ${C.gold}`,
              filter: "drop-shadow(2px 2px 0 rgba(17,18,15,0.5))",
            }}
          />

          <div
            style={{
              width: size,
              height: size,
              borderRadius: "50%",
              border: `6px solid ${C.ink}`,
              boxShadow: "8px 10px 0 rgba(17,18,15,0.35)",
              overflow: "hidden",
              transform: `rotate(${rotation}deg)`,
              background: C.paper,
            }}
          >
            {labels.map((label, i) => {
              const start = i * segAngle;
              const mid = start + segAngle / 2;
              const cobalt = i % 2 === 0;
              return (
                <div key={i}>
                  <div
                    style={{
                      position: "absolute",
                      left: r,
                      top: r,
                      width: r,
                      height: r,
                      transformOrigin: "0 0",
                      transform: `rotate(${start}deg) skewY(${90 - segAngle}deg)`,
                      background: cobalt ? C.cobalt : C.paperSunk,
                      borderRight: `1px solid ${C.ink}`,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: r,
                      top: r,
                      width: r - 40,
                      transformOrigin: "0 0",
                      transform: `rotate(${mid}deg) translate(70px, -12px)`,
                      fontFamily: fonts.elite,
                      fontSize: 18,
                      color: cobalt ? C.cobaltInk : C.ink,
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label.length > 12 ? label.slice(0, 11) + "…" : label}
                  </div>
                </div>
              );
            })}
            <div
              style={{
                position: "absolute",
                left: r - 36,
                top: r - 36,
                width: 72,
                height: 72,
                borderRadius: "50%",
                background: C.gold,
                border: `4px solid ${C.ink}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: fonts.elite,
                fontSize: 16,
                fontWeight: 700,
                zIndex: 2,
              }}
            >
              $SLAY
            </div>
          </div>
        </div>

        <div style={{ position: "absolute", bottom: 40, width: "100%" }}>
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
