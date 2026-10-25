import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { CobaltPanel, DeskBackground, RevealBanner, TitleBlock } from "./components/Desk";
import { assets, C, fonts, type WheelProps } from "./theme";

function seededShuffle(arr: string[], seed: number): string[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = (s >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

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
  const reelNames: string[] = [];
  const totalSlots = list.length * 7 + list.length;
  for (let rot = 0; rot < Math.ceil(totalSlots / list.length); rot++) {
    for (const name of seededShuffle(list, rot * 7 + 42)) {
      if (reelNames.length < totalSlots) reelNames.push(name);
    }
  }
  // Near-miss: put a decoy just before the winner
  const decoy = seededShuffle(list.filter((n) => n !== winner), 77)[0] ?? list[0]!;
  reelNames.push(decoy);
  reelNames.push(winner);
  const winnerIndex = reelNames.length - 1;
  const after = seededShuffle(list, 999);
  for (let i = 0; i < Math.max(10, list.length * 2); i++) {
    reelNames.push(after[i % after.length]!);
  }

  const SLOT = 74;
  const SPIN_START = 22;
  const SPIN_END = 158;
  const revealStart = 168;
  const viewportH = 540;
  const center = viewportH / 2;

  const spinProgress = interpolate(frame, [SPIN_START, SPIN_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Stronger ease-out so the near-miss reads
  const eased = 1 - Math.pow(1 - spinProgress, 4);
  const reelOffset = eased * winnerIndex * SLOT;

  const titleOp = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const landed = frame >= SPIN_END;
  const landFlash = landed
    ? interpolate(frame, [SPIN_END, SPIN_END + 8, SPIN_END + 20], [0, 1, 0.35], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  const winnerOp = interpolate(frame, [revealStart, revealStart + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const winnerScale = spring({
    frame: Math.max(0, frame - revealStart),
    fps,
    from: 0.55,
    to: 1,
    durationInFrames: 20,
  });

  const arrowPulse =
    frame >= SPIN_START && frame <= SPIN_END
      ? interpolate(frame % 8, [0, 4, 8], [0.7, 1, 0.7])
      : 0.95;

  return (
    <DeskBackground>
      <AbsoluteFill style={{ paddingTop: 40 }}>
        <div style={{ opacity: titleOp }}>
          <TitleBlock title={title} subtitle={subtitle} />
        </div>

        {/* Polaroid Eli peek */}
        <div
          style={{
            position: "absolute",
            right: 48,
            top: 200,
            width: 200,
            padding: 12,
            paddingBottom: 36,
            background: C.paperSunk,
            border: `2px solid ${C.ink}`,
            boxShadow: "5px 6px 0 rgba(17,18,15,0.35)",
            transform: "rotate(4deg)",
            zIndex: 3,
          }}
        >
          <Img src={assets.eli} style={{ width: "100%", display: "block" }} />
          <div
            style={{
              marginTop: 8,
              textAlign: "center",
              fontFamily: fonts.elite,
              fontSize: 16,
              color: C.ink,
            }}
          >
            watching…
          </div>
          <Img
            src={assets.tape}
            style={{
              position: "absolute",
              top: -18,
              left: 40,
              width: 110,
              transform: "rotate(-12deg)",
            }}
          />
        </div>

        <CobaltPanel
          style={{
            marginTop: 28,
            marginLeft: 80,
            width: 620,
            height: viewportH + 48,
            padding: 24,
          }}
          rotate={-0.8}
        >
          <div
            style={{
              fontFamily: fonts.elite,
              fontSize: 14,
              letterSpacing: 4,
              color: C.gold,
              marginBottom: 10,
              textAlign: "center",
              textTransform: "uppercase",
            }}
          >
            Brother Eli · daily draw
          </div>
          <div
            style={{
              height: viewportH,
              overflow: "hidden",
              borderRadius: 3,
              border: `3px solid ${C.ink}`,
              background: "rgba(8,20,60,0.5)",
              position: "relative",
              boxShadow: landFlash > 0 ? `inset 0 0 ${40 * landFlash}px ${C.gold}` : undefined,
            }}
          >
            {/* Vignette fades */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 120,
                background: "linear-gradient(180deg, rgba(8,20,60,0.95), transparent)",
                zIndex: 6,
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: 120,
                background: "linear-gradient(0deg, rgba(8,20,60,0.95), transparent)",
                zIndex: 6,
                pointerEvents: "none",
              }}
            />

            {/* Selection window */}
            <div
              style={{
                position: "absolute",
                top: center - SLOT / 2 - 6,
                left: 12,
                right: 12,
                height: SLOT + 12,
                borderTop: `3px solid ${C.gold}`,
                borderBottom: `3px solid ${C.gold}`,
                background: `linear-gradient(90deg, transparent, rgba(245,213,58,${0.12 + landFlash * 0.25}), transparent)`,
                zIndex: 5,
                pointerEvents: "none",
                opacity: arrowPulse,
              }}
            />

            {/* Side arrows */}
            <div
              style={{
                position: "absolute",
                top: center - 14,
                left: 8,
                zIndex: 7,
                color: C.gold,
                fontSize: 28,
                opacity: arrowPulse,
                textShadow: `0 0 8px ${C.gold}`,
              }}
            >
              ▶
            </div>
            <div
              style={{
                position: "absolute",
                top: center - 14,
                right: 8,
                zIndex: 7,
                color: C.gold,
                fontSize: 28,
                opacity: arrowPulse,
                textShadow: `0 0 8px ${C.gold}`,
              }}
            >
              ◀
            </div>

            <div
              style={{
                position: "relative",
                transform: `translateY(${center - SLOT / 2 - reelOffset}px)`,
              }}
            >
              {reelNames.map((name, i) => {
                const dist = Math.abs(i * SLOT - reelOffset);
                const isCenter = dist < SLOT / 2;
                const dim = interpolate(dist, [0, SLOT * 2, SLOT * 4], [1, 0.5, 0.15], {
                  extrapolateRight: "clamp",
                });
                const isWinnerSlot = i === winnerIndex && landed;
                return (
                  <div
                    key={i}
                    style={{
                      height: SLOT,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 12,
                      fontFamily: fonts.elite,
                      fontSize: isCenter ? 36 : 26,
                      fontWeight: isCenter ? 700 : 400,
                      color: isWinnerSlot ? C.gold : C.cobaltInk,
                      opacity: dim,
                      textTransform: "uppercase",
                      letterSpacing: isCenter ? 3 : 1,
                      textShadow: isWinnerSlot ? `0 0 ${12 * landFlash}px ${C.gold}` : undefined,
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
            top: 195,
            left: 95,
            width: 150,
            opacity: 0.92,
            transform: "rotate(-22deg)",
            zIndex: 4,
          }}
        />

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
