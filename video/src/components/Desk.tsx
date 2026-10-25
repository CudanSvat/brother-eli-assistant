import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { assets, C, fonts } from "../theme";

/** Cream graph-paper desk full bleed + brand fonts. */
export const DeskBackground: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.desk,
      backgroundImage: `
          linear-gradient(${C.grid} 1px, transparent 1px),
          linear-gradient(90deg, ${C.grid} 1px, transparent 1px)
        `,
      backgroundSize: "22px 22px",
      fontFamily: fonts.serif,
      overflow: "hidden",
    }}
  >
    <style>{`
      @font-face {
        font-family: 'SpecialElite';
        src: url('${assets.fontElite}') format('truetype');
        font-weight: 400;
      }
      @font-face {
        font-family: 'LibreBaskerville';
        src: url('${assets.fontSerif}') format('truetype');
        font-weight: 400;
      }
      @font-face {
        font-family: 'LibreBaskerville';
        src: url('${assets.fontSerifBold}') format('truetype');
        font-weight: 700;
      }
    `}</style>
    {children}
  </AbsoluteFill>
);

/** Torn-ish cobalt panel using brand texture. */
export const CobaltPanel: React.FC<{
  style?: React.CSSProperties;
  children?: React.ReactNode;
  rotate?: number;
}> = ({ style, children, rotate = -1.2 }) => (
  <div
    style={{
      position: "relative",
      overflow: "hidden",
      borderRadius: 4,
      boxShadow: "6px 8px 0 rgba(17,18,15,0.35)",
      transform: `rotate(${rotate}deg)`,
      color: C.cobaltInk,
      ...style,
    }}
  >
    <Img
      src={assets.cobalt}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }}
    />
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(160deg, rgba(31,79,224,0.55), rgba(15,40,120,0.75))",
      }}
    />
    <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
  </div>
);

export const TitleBlock: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 8,
      padding: "0 40px",
    }}
  >
    <div
      style={{
        fontFamily: fonts.elite,
        fontSize: 22,
        letterSpacing: 5,
        textTransform: "uppercase",
        color: C.muted,
      }}
    >
      $SLAY
    </div>
    <div
      style={{
        fontFamily: fonts.serif,
        fontWeight: 700,
        fontSize: 52,
        color: C.ink,
        textAlign: "center",
        lineHeight: 1.05,
      }}
    >
      {title}
    </div>
    <div style={{ fontFamily: fonts.elite, fontSize: 20, color: C.muted }}>{subtitle}</div>
  </div>
);

export const RevealBanner: React.FC<{
  hasWinner: boolean;
  winner: string;
  prizeLine: string;
  opacity: number;
  scale: number;
}> = ({ hasWinner, winner, prizeLine, opacity, scale }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 6,
      opacity,
      transform: `scale(${scale})`,
    }}
  >
    <div
      style={{
        fontFamily: fonts.elite,
        fontSize: 26,
        letterSpacing: 4,
        color: hasWinner ? C.positive : C.negative,
        fontWeight: 700,
      }}
    >
      {hasWinner ? "WINNER" : "NO WINNER"}
    </div>
    <div
      style={{
        fontFamily: fonts.serif,
        fontWeight: 700,
        fontSize: 44,
        color: C.ink,
        textTransform: "uppercase",
        letterSpacing: 2,
      }}
    >
      {winner}
    </div>
    <div
      style={{
        marginTop: 4,
        padding: "8px 18px",
        background: C.gold,
        color: C.goldInk,
        fontFamily: fonts.elite,
        fontSize: 22,
        boxShadow: "3px 3px 0 rgba(17,18,15,0.4)",
      }}
    >
      {prizeLine}
    </div>
  </div>
);
