export const WHEEL_VARIANTS = {
  reel: "CobaltReel",
  wheel: "PaperWheel",
  bag: "SlayBagDraw",
  stamp: "StampPress",
} as const;

export type WheelVariantKey = keyof typeof WHEEL_VARIANTS;
export type WheelCompositionId = (typeof WHEEL_VARIANTS)[WheelVariantKey];

const KEYS = Object.keys(WHEEL_VARIANTS) as WheelVariantKey[];

export function parseWheelVariant(raw: string | undefined): WheelVariantKey | "random" | null {
  if (!raw) return "random";
  const q = raw.trim().toLowerCase();
  if (!q || q === "random") return "random";
  if (q in WHEEL_VARIANTS) return q as WheelVariantKey;
  return null;
}

export function resolveCompositionId(key: WheelVariantKey | "random"): {
  variant: WheelVariantKey;
  compositionId: WheelCompositionId;
} {
  const variant = key === "random" ? KEYS[Math.floor(Math.random() * KEYS.length)]! : key;
  return { variant, compositionId: WHEEL_VARIANTS[variant] };
}

export function variantHelp(): string {
  return "Usage: /wheel_test [reel|wheel|bag|stamp|random]";
}
