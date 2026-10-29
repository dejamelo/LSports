export const defaultTheme = {
  primary: "#C9F464", secondary: "#253A31", background: "#101619", surface: "#151D21",
  text: "#E8EDEF", oddsButton: "#202A2F", selected: "#C9F464",
} as const;
export type ThemeColors = { [K in keyof typeof defaultTheme]: string };
