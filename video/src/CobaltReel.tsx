import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { CobaltPanel, DeskBackground, RevealBanner, TitleBlock } from "./components/Desk";
import { assets, C, fonts, type WheelProps } from "./theme";

export const CobaltReel: React.FC<WheelProps> = ({
  title,
  subtitle,
  players,
  winner,
  prizeLine,
  hasWinner,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const list = players.length ? players : ["Eli #1", "Eli #2", "Eli #3"];
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

  const reelNames: string[] = [];
  const totalSlots = list.length * 6 + list.length;
  for (let rot = 0; rot < Math.ceil(totalSlots / list.length); rot++) {
    for (const name of seededShuffle(list, rot * 7 + 42)) {
      if (reelNames.length < totalSlots) reelNames.push(name);
    }
  }
  reelNames.push(winner);
  const winnerIndex = reelNames.length - 1;
  const after = seededShuffle(list, 999);
  for (let i = 0; i < Math.max(8, list.length * 2); i++) {
    reelNames.push(after[i % after.length]!);
  }

  const SLOT = 70;
  const SPIN_START = 25;
  const SPIN_END = 155;
  const revealStart = 160;
  const viewportH = 520;
  const center = viewportH / 2;

  const spinProgress = interpolate(frame, [SPIN_START, SPIN_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eased = 1 - Math.pow(1 - spinProgress, 3);
  const reelOffset = eased * winnerIndex * SLOT;

  const titleOp = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const winnerOp = interpolate(frame, [revealStart, revealStart + 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const winnerScale = spring({
    frame: Math.max(0, frame - revealStart),
    fps,
    from: 0.6,
    to: 1,
    durationInFrames: 18,
  });

  return (
    <DeskBackground>
      <AbsoluteFill style={{ paddingTop: 48, alignItems: "center" }}>
        <div style={{ opacity: titleOp }}>
          <TitleBlock title={title} subtitle={subtitle} />
        </div>

        <CobaltPanel
          style={{
            marginTop: 36,
            width: 640,
            height: viewportH + 40,
            padding: 20,
          }}
        >
          <div
            style={{
              height: viewportH,
              overflow: "hidden",
              borderRadius: 3,
              border: `2px solid ${C.ink}`,
              background: "rgba(8,20,60,0.45)",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: center - SLOT / 2 - 4,
                left: 0,
                right: 0,
                height: SLOT + 8,
                borderTop: `2px solid ${C.gold}`,
                borderBottom: `2px solid ${C.gold}`,
                background: "linear-gradient(90deg, transparent, rgba(245,213,58,0.18), transparent)",
                zIndex: 5,
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "relative",
                transform: `translateY(${center - SLOT / 2 - reelOffset}px)`,
              }}
            >
              {reelNames.map((name, i) => {
                const dist = Math.abs(i * SLOT - reelOffset);
                const isCenter = dist < SLOT / 2;
                const dim = interpolate(dist, [0, SLOT * 2, SLOT * 4], [1, 0.55, 0.2], {
                  extrapolateRight: "clamp",
                });
                return (
                  <div
                    key={i}
                    style={{
                      height: SLOT,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: fonts.elite,
                      fontSize: isCenter ? 34 : 26,
                      fontWeight: isCenter ? 700 : 400,
                      color: isCenter && frame >= SPIN_END ? C.gold : C.cobaltInk,
                      opacity: dim,
                      textTransform: "uppercase",
                      letterSpacing: 2,
                    }}
                  >
                    {name}
                  </div>
                );
              })}
            </div>
          </div>
        </CobaltPanel>

        <Img
          src={assets.tape}
          style={{
            position: "absolute",
            top: 210,
            left: 180,
            width: 140,
            opacity: 0.9,
            transform: "rotate(-18deg)",
          }}
        />

        <div style={{ position: "absolute", bottom: 48, width: "100%", alignItems: "center" }}>
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
