import React from "react";
import { Composition } from "remotion";
import { CobaltReel } from "./CobaltReel";
import { PaperWheel } from "./PaperWheel";
import { SlayBagDraw } from "./SlayBagDraw";
import { StampPress } from "./StampPress";
import { defaultWheelProps } from "./theme";

const SIZE = { durationInFrames: 210, fps: 30, width: 1080, height: 1080 } as const;

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="CobaltReel" component={CobaltReel} {...SIZE} defaultProps={defaultWheelProps} />
    <Composition id="PaperWheel" component={PaperWheel} {...SIZE} defaultProps={defaultWheelProps} />
    <Composition id="SlayBagDraw" component={SlayBagDraw} {...SIZE} defaultProps={defaultWheelProps} />
    <Composition id="StampPress" component={StampPress} {...SIZE} defaultProps={defaultWheelProps} />
  </>
);
