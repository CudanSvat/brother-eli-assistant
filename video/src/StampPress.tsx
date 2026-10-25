import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { CobaltPanel, DeskBackground, RevealBanner, TitleBlock } from "./components/Desk";
import { assets, C, fonts, type WheelProps } from "./theme";

type Attempt = {
  label: string;
  kind: "reject" | "near" | "final";
  x: number;
  y: number;
  rot: number;
};

function buildAttempts(players: string[], winner: string, hasWinner: boolean): Attempt[] {
  const pool = (players.length ? players : ["Eli #12", "Eli #88", "Eli #233"]).filter(
    (p) => p !== winner,
  );
  const picks: string[] = [];
  for (let i = 0; i < 6; i++) {
    picks.push(pool[i % Math.max(1, pool.length)] ?? `Eli #${(i + 1) * 37}`);
  }
  const layout: Attempt[] = [
    { label: picks[0]!, kind: "reject", x: 120, y: 310, rot: -8 },
    { label: picks[1]!, kind: "reject", x: 400, y: 290, rot: 5 },
    { label: picks[2]!, kind: "near", x: 680, y: 320, rot: -3 },
    { label: picks[3]!, kind: "reject", x: 200, y: 470, rot: 7 },
    { label: picks[4]!, kind: "near", x: 520, y: 460, rot: -6 },
    { label: picks[5]!, kind: "reject", x: 780, y: 490, rot: 4 },
    {
      label: hasWinner ? winner : "NO WINNER",
      kind: "final",
      x: 340,
      y: 640,
      rot: -2,
    },
  ];
  return layout;
}

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

  const attempts = buildAttempts(players, winner, hasWinner);
  const beat = 18;
  const start = 36;
  const finalIndex = attempts.length - 1;
  const finalBeat = start + finalIndex * beat;

  const titleOp = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });

  // Which attempt is being stamped now
  const activeIndex = (() => {
    if (frame < start) return -1;
    const i = Math.floor((frame - start) / beat);
    return Math.min(i, finalIndex);
  })();

  const pressFor = (i: number) => {
    const t0 = start + i * beat;
    if (frame < t0 || frame > t0 + 14) return { y: -90, ink: 0 };
    const y = interpolate(frame, [t0, t0 + 4, t0 + 10, t0 + 14], [-90, 55, 40, -70], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const ink = interpolate(frame, [t0 + 3, t0 + 6, t0 + 14], [0, 1, 0.4], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return { y, ink };
  };

  const press = activeIndex >= 0 ? pressFor(activeIndex) : { y: -90, ink: 0 };
  // Aim press over active stamp
  const aim = activeIndex >= 0 ? attempts[activeIndex]! : { x: 540, y: 400 };
  const pressX = interpolate(
    frame,
    activeIndex >= 0
      ? [start + activeIndex * beat - 4, start + activeIndex * beat + 2]
      : [0, 1],
    activeIndex >= 1
      ? [attempts[activeIndex - 1]!.x + 70, aim.x + 70]
      : [aim.x + 70, aim.x + 70],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const revealStart = finalBeat + 28;
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

  // Ledger lines that fill as rejects accumulate
  const ledgerCount = Math.max(0, Math.min(activeIndex, finalIndex));

  return (
    <DeskBackground>
      <AbsoluteFill style={{ paddingTop: 28 }}>
        <div style={{ opacity: titleOp }}>
          <TitleBlock title={title} subtitle={subtitle || "Mint press · reject until certified"} />
        </div>

        {/* Certificate sheet */}
        <div
          style={{
            position: "absolute",
            left: 70,
            top: 200,
            width: 940,
            height: 720,
            background: C.paperSunk,
            border: `3px solid ${C.ink}`,
            boxShadow: "8px 10px 0 rgba(17,18,15,0.3)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 16,
              border: `1.5px dashed ${C.rule}`,
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 28,
              left: 36,
              fontFamily: fonts.elite,
              fontSize: 18,
              letterSpacing: 3,
              color: C.muted,
              textTransform: "uppercase",
            }}
          >
            Brother Eli · official draw ledger
          </div>
          <div
            style={{
              position: "absolute",
              top: 28,
              right: 36,
              fontFamily: fonts.elite,
              fontSize: 16,
              color: C.muted,
            }}
          >
            FORM 888
          </div>

          {/* Ledger sidebar */}
          <CobaltPanel
            style={{ position: "absolute", right: 28, top: 70, width: 200, padding: 14 }}
            rotate={1.5}
          >
            <div
              style={{
                fontFamily: fonts.elite,
                fontSize: 13,
                letterSpacing: 2,
                color: C.gold,
                marginBottom: 8,
              }}
            >
              REJECTS
            </div>
            {attempts.slice(0, finalIndex).map((a, i) => {
              const shown = i < ledgerCount;
              return (
                <div
                  key={i}
                  style={{
                    fontFamily: fonts.elite,
                    fontSize: 15,
                    color: C.cobaltInk,
                    opacity: shown ? 1 : 0.25,
                    textDecoration: shown ? "line-through" : "none",
                    marginBottom: 4,
                  }}
                >
                  {a.label}
                </div>
              );
            })}
          </CobaltPanel>

          {/* Stamped attempts */}
          {attempts.map((a, i) => {
            const t0 = start + i * beat;
            const appear = interpolate(frame, [t0 + 3, t0 + 7], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const slam = interpolate(frame, [t0 + 3, t0 + 7, t0 + 12], [0.4, 1.18, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            if (frame < t0 + 3) return null;

            const isFinal = a.kind === "final";
            const border =
              a.kind === "reject" ? C.negative : a.kind === "near" ? C.cobalt : hasWinner ? C.positive : C.ink;
            const badge =
              a.kind === "reject" ? "DENIED" : a.kind === "near" ? "CLOSE" : hasWinner ? "CERTIFIED" : "VOID";

            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: a.x,
                  top: a.y - 200,
                  opacity: appear,
                  transform: `scale(${slam}) rotate(${a.rot}deg)`,
                  width: isFinal ? 360 : 220,
                  padding: isFinal ? "22px 20px" : "14px 16px",
                  border: `${isFinal ? 5 : 3}px solid ${border}`,
                  background: isFinal ? C.paper : "rgba(248,243,232,0.92)",
                  boxShadow: "4px 5px 0 rgba(17,18,15,0.28)",
                  textAlign: "center",
                  zIndex: isFinal ? 4 : 2,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.elite,
                    fontSize: isFinal ? 16 : 13,
                    letterSpacing: 3,
                    color: border,
                    marginBottom: 6,
                  }}
                >
                  {badge}
                </div>
                <div
                  style={{
                    fontFamily: fonts.serif,
                    fontWeight: 700,
                    fontSize: isFinal ? 36 : 22,
                    color: C.ink,
                    textTransform: "uppercase",
                  }}
                >
                  {a.label}
                </div>
                {a.kind === "reject" && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: fonts.elite,
                      fontSize: 64,
                      color: C.negative,
                      opacity: 0.35,
                      transform: "rotate(-18deg)",
                      pointerEvents: "none",
                    }}
                  >
                    ✕
                  </div>
                )}
                {isFinal && hasWinner && (
                  <div
                    style={{
                      marginTop: 10,
                      display: "inline-block",
                      padding: "6px 12px",
                      background: C.gold,
                      fontFamily: fonts.elite,
                      fontSize: 16,
                      color: C.ink,
                    }}
                  >
                    {prizeLine}
                  </div>
                )}
              </div>
            );
          })}

          {/* Ink blot under press on impact */}
          {press.ink > 0.5 && activeIndex >= 0 && (
            <div
              style={{
                position: "absolute",
                left: aim.x + 40,
                top: aim.y - 160,
                width: 100,
                height: 28,
                borderRadius: "50%",
                background: `rgba(17,18,15,${0.15 * press.ink})`,
                filter: "blur(4px)",
                zIndex: 1,
              }}
            />
          )}
        </div>

        {/* Mint press head */}
        <div
          style={{
            position: "absolute",
            left: pressX,
            top: 150,
            transform: `translateY(${press.y}px)`,
            zIndex: 10,
            width: 160,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: 18,
              height: 100,
              marginLeft: 71,
              background: C.rule,
              border: `2px solid ${C.ink}`,
            }}
          />
          <div
            style={{
              width: 160,
              height: 78,
              background: C.ink,
              borderRadius: 6,
              border: `3px solid ${C.ink}`,
              boxShadow: "5px 6px 0 rgba(17,18,15,0.4)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: fonts.elite,
              color: C.gold,
              letterSpacing: 2,
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.8 }}>MINT</div>
            <div style={{ fontSize: 22 }}>PRESS</div>
          </div>
        </div>

        <Img
          src={assets.tape}
          style={{
            position: "absolute",
            top: 185,
            left: 90,
            width: 140,
            transform: "rotate(-16deg)",
            zIndex: 11,
          }}
        />

        <Img
          src={assets.eli}
          style={{
            position: "absolute",
            right: 20,
            bottom: 20,
            width: 220,
            opacity: interpolate(frame, [revealStart - 10, revealStart + 10], [0.35, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            filter: "drop-shadow(4px 5px 0 rgba(17,18,15,0.3))",
            zIndex: 8,
          }}
        />

        <div style={{ position: "absolute", bottom: 28, left: 40, zIndex: 9 }}>
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
