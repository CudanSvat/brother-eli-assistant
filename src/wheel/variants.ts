export const WHEEL_VARIANTS = {
  reel: "CobaltReel",
  stamp: "StampPress",
} as const;

export type WheelVariantKey = keyof typeof WHEEL_VARIANTS;
export type WheelCompositionId = (typeof WHEEL_VARIANTS)[WheelVariantKey];

export function parseWheelVariant(raw: string | undefined): WheelVariantKey | null {
  if (!raw) return "reel";
  const q = raw.trim().toLowerCase();
  if (!q || q === "random" || q === "reel") return "reel";
  if (q === "stamp") return "stamp";
  return null;
}

export function resolveCompositionId(key: WheelVariantKey): {
  variant: WheelVariantKey;
  compositionId: WheelCompositionId;
} {
  return { variant: key, compositionId: WHEEL_VARIANTS[key] };
}

export function variantHelp(): string {
  return "Usage: /wheel_test [reel|stamp] — default is reel";
}
