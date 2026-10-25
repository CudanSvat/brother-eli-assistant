import React from "react";
import { Composition } from "remotion";
import { CobaltReel } from "./CobaltReel";
import { StampPress } from "./StampPress";
import { defaultWheelProps } from "./theme";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="CobaltReel"
      component={CobaltReel}
      // ~5.5s spin/reveal + ~5.5s still hold so Telegram loops linger on the winner
      durationInFrames={330}
      fps={30}
      width={1080}
      height={1080}
      defaultProps={defaultWheelProps}
    />
    <Composition
      id="StampPress"
      component={StampPress}
      durationInFrames={240}
      fps={30}
      width={1080}
      height={1080}
      defaultProps={defaultWheelProps}
    />
  </>
);
