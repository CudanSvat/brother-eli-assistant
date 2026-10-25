import { staticFile } from "remotion";

/** Brother Eli site / scrapbook tokens (launchpad + shill card). */
export const C = {
  desk: "#e8e0cd",
  paper: "#efe9dc",
  paperSunk: "#f8f3e8",
  ink: "#11120f",
  muted: "#463e32",
  rule: "#a3937a",
  cobalt: "#1f4fe0",
  cobaltInk: "#f3ecdc",
  gold: "#f5d53a",
  goldInk: "#11120f",
  positive: "#157524",
  negative: "#c4211b",
  grid: "rgba(17, 18, 15, 0.08)",
};

export const fonts = {
  elite: "SpecialElite, 'Courier New', monospace",
  serif: "LibreBaskerville, Georgia, serif",
};

export const assets = {
  cobalt: staticFile("textures/cobalt-paper.webp"),
  tape: staticFile("textures/tape-280.webp"),
  eli: staticFile("art/brother-eli.png"),
  fontElite: staticFile("fonts/SpecialElite-Regular.ttf"),
  fontSerif: staticFile("fonts/LibreBaskerville-Regular.ttf"),
  fontSerifBold: staticFile("fonts/LibreBaskerville-Bold.ttf"),
};

export interface WheelProps {
  title: string;
  subtitle: string;
  players: string[];
  winner: string;
  prizeLine: string;
  hasWinner: boolean;
  /** Remote NFT art URL; polaroid morphs to this on a win. */
  winnerImageUrl: string | null;
}

export const defaultWheelProps: WheelProps = {
  title: "Eli Selects",
  subtitle: "Daily $SLAY draw",
  players: [
    "Brother Eli Bald Kings #1",
    "Brother Eli Bald Kings #42",
    "Brother Eli Bald Kings #233",
    "8 SLAY",
    "88 SLAY",
    "888 SLAY",
    "8888 SLAY",
  ],
  winner: "Brother Eli Bald Kings #233",
  prizeLine: "88 SLAY",
  hasWinner: true,
  winnerImageUrl: "https://brothereli.com/nft/images/233.png",
};
