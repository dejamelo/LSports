export const defaultSportsbookTheme = Object.freeze({
  primary: "#C9F464",
  secondary: "#253A31",
  background: "#101619",
  surface: "#151D21",
  text: "#E8EDEF",
  oddsButton: "#202A2F",
  selected: "#C9F464",
});
export type SportsbookTheme = { [K in keyof typeof defaultSportsbookTheme]: string };
export class ThemeValidationError extends Error {
  constructor(public code: "INVALID_THEME" | "THEME_CONTRAST", message: string) { super(message); }
}
const fields = Object.keys(defaultSportsbookTheme) as (keyof SportsbookTheme)[];
const luminance = (hex: string) => {
  const channels = hex.slice(1).match(/.{2}/g)!.map((v) => parseInt(v, 16) / 255);
  const linear = channels.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
export const contrastRatio = (a: string, b: string) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
export function validateSportsbookTheme(input: unknown): SportsbookTheme {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ThemeValidationError("INVALID_THEME", "El tema debe ser un objeto de colores válidos.");
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !fields.includes(key as keyof SportsbookTheme)) || fields.some((key) => typeof source[key] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(source[key] as string)))
    throw new ThemeValidationError("INVALID_THEME", "Usá únicamente los siete colores hexadecimales permitidos.");
  const theme = Object.fromEntries(fields.map((key) => [key, (source[key] as string).toUpperCase()])) as SportsbookTheme;
  if ([theme.background, theme.surface].some((surface) => contrastRatio(theme.text, surface) < 4.5 || contrastRatio(theme.primary, surface) < 4.5) ||
      ["#A2B3BB", "#D5EEAD"].some((ink) => contrastRatio(ink, theme.oddsButton) < 4.5) ||
      ["#213119", "#192415", "#40562D"].some((ink) => contrastRatio(ink, theme.selected) < 4.5) ||
      ["#203017", "#111B10", "#192415"].some((ink) => contrastRatio(ink, theme.primary) < 4.5) || contrastRatio("#C3E99A", theme.secondary) < 4.5)
    throw new ThemeValidationError("THEME_CONTRAST", "Mantené contraste WCAG AA (4,5:1) en fondos, textos, botones de odds y selección marcada.");
  // Suspended/unavailable state remains explicit and is not controlled by theme.
  return theme;
}
