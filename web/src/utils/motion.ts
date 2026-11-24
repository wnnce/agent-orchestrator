export const EASE_OUT_EXPO = [0.22, 1, 0.36, 1] as const;

export const SPRING_SNAPPY = {
  type: "spring",
  stiffness: 520,
  damping: 36,
  mass: 0.8,
} as const;

export const SPRING_SOFT = {
  type: "spring",
  stiffness: 380,
  damping: 32,
  mass: 0.9,
} as const;
