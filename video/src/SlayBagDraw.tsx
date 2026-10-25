import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { DeskBackground, RevealBanner, TitleBlock } from "./components/Desk";
import { assets, C, fonts, type WheelProps } from "./theme";

export const SlayBagDraw: React.FC<WheelProps> = ({
  title,
  subtitle,
  winner,
  prizeLine,
  hasWinner,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 0-30 title, 30-90 rummage, 90-140 pull ticket, 140-210 reveal
  const rummage = frame >= 30 && frame < 90;
  const bagShake = rummage
    ? Math.sin(frame * 1.2) * 10 + Math.sin(frame * 2.1) * 4
    : interpolate(frame, [90, 110], [0, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const eliX = interpolate(frame, [20, 50, 90, 130], [-80, 40, 40, 120], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eliY = interpolate(frame, [20, 50, 90, 120], [80, 40, 20, -10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eliRot = interpolate(frame, [30, 90], [-6, 8], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const ticketOut = interpolate(frame, [100, 140], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ticketY = interpolate(ticketOut, [0, 1], [80, -40]);
  const ticketOp = ticketOut;

  const revealStart = 155;
  const winnerOp = interpolate(frame, [revealStart, revealStart + 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const winnerScale = spring({
    frame: Math.max(0, frame - revealStart),
    fps,
    from: 0.5,
    to: 1,
    durationInFrames: 18,
  });

  const titleOp = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });

  return (
    <DeskBackground>
      <AbsoluteFill style={{ paddingTop: 40 }}>
        <div style={{ opacity: titleOp }}>
          <TitleBlock title={title} subtitle={subtitle} />
        </div>

        {/* Bag */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 420,
            transform: `translateX(-50%) rotate(${bagShake}deg)`,
            width: 280,
            height: 300,
          }}
        >
          <div
            style={{
              width: 280,
              height: 240,
              background: `linear-gradient(160deg, ${C.gold}, #e0b820)`,
              border: `5px solid ${C.ink}`,
              borderRadius: "40% 40% 28% 28%",
              boxShadow: "8px 10px 0 rgba(17,18,15,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: fonts.elite,
              fontSize: 42,
              fontWeight: 700,
              color: C.ink,
            }}
          >
            $SLAY
          </div>
          <div
            style={{
              position: "absolute",
              top: -20,
              left: 60,
              width: 160,
              height: 50,
              background: C.ink,
              borderRadius: 8,
              boxShadow: "3px 3px 0 rgba(17,18,15,0.3)",
            }}
          />
        </div>

        {/* Ticket pulled from bag */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 340,
            opacity: ticketOp,
            transform: `translateX(-50%) translateY(${ticketY}px) rotate(-6deg)`,
            width: 320,
            padding: "22px 18px",
            background: C.paperSunk,
            border: `3px solid ${C.ink}`,
            boxShadow: "5px 6px 0 rgba(17,18,15,0.35)",
            textAlign: "center",
            fontFamily: fonts.elite,
            zIndex: 3,
          }}
        >
          <div style={{ fontSize: 16, color: C.muted, letterSpacing: 3 }}>DRAWN</div>
          <div style={{ fontSize: 36, color: C.ink, marginTop: 6, textTransform: "uppercase" }}>
            {hasWinner ? winner : "— blank —"}
          </div>
        </div>

        {/* Eli character */}
        <Img
          src={assets.eli}
          style={{
            position: "absolute",
            right: 40 + eliX,
            bottom: 40 + eliY,
            width: 340,
            transform: `rotate(${eliRot}deg)`,
            filter: "drop-shadow(6px 8px 0 rgba(17,18,15,0.35))",
            zIndex: 4,
          }}
        />

        <div style={{ position: "absolute", bottom: 36, left: 40, zIndex: 5 }}>
          <RevealBanner
            hasWinner={hasWinner}
            winner={winner}
            prizeLine={prizeLine}
            opacity={winnerOp}
            scale={winnerScale}
          />
        </div>
      </AbsoluteFill>
    </DeskBackground>
  );
};
