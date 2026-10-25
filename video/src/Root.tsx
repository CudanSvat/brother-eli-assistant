import React from "react";
import { Composition } from "remotion";
import { WheelOfFortune, type WheelOfFortuneProps } from "./WheelOfFortune";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="WheelOfFortune"
      component={WheelOfFortune}
      durationInFrames={210}
      fps={30}
      width={1080}
      height={1080}
      defaultProps={
        {
          title: "Brother Eli Wheel",
          subtitle: "Daily $SLAY spin",
          players: ["Eli #1", "Eli #42", "Eli #233", "1 SLAY", "2 SLAY", "3 SLAY", "4 SLAY"],
          winner: "Eli #233",
          prizeLine: "2 SLAY",
          hasWinner: true,
        } satisfies WheelOfFortuneProps
      }
    />
  );
};
