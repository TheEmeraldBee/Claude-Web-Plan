export type ThemeVars = Record<string, string>;

export const THEMES: Record<string, ThemeVars> = {
  "catppuccin-mocha": {
    "--base": "#1e1e2e", "--mantle": "#181825", "--crust": "#11111b",
    "--surface0": "#313244", "--surface1": "#45475a", "--surface2": "#585b70",
    "--overlay0": "#6c7086", "--overlay1": "#7f849c",
    "--text": "#cdd6f4", "--subtext1": "#bac2de", "--subtext0": "#a6adc8",
    "--mauve": "#cba6f7", "--blue": "#89b4fa", "--sapphire": "#74c7ec",
    "--teal": "#94e2d5", "--green": "#a6e3a1", "--yellow": "#f9e2af",
    "--peach": "#fab387", "--red": "#f38ba8", "--pink": "#f5c2e7", "--flamingo": "#f2cdcd",
  },
  "catppuccin-latte": {
    "--base": "#eff1f5", "--mantle": "#e6e9ef", "--crust": "#dce0e8",
    "--surface0": "#ccd0da", "--surface1": "#bcc0cc", "--surface2": "#acb0be",
    "--overlay0": "#9ca0b0", "--overlay1": "#8c8fa1",
    "--text": "#4c4f69", "--subtext1": "#5c5f77", "--subtext0": "#6c6f85",
    "--mauve": "#8839ef", "--blue": "#1e66f5", "--sapphire": "#209fb5",
    "--teal": "#179299", "--green": "#40a02b", "--yellow": "#df8e1d",
    "--peach": "#fe640b", "--red": "#d20f39", "--pink": "#ea76cb", "--flamingo": "#dd7878",
  },
  "nord": {
    "--base": "#2e3440", "--mantle": "#272c36", "--crust": "#1e2330",
    "--surface0": "#3b4252", "--surface1": "#434c5e", "--surface2": "#4c566a",
    "--overlay0": "#616e88", "--overlay1": "#6e7d9e",
    "--text": "#eceff4", "--subtext1": "#e5e9f0", "--subtext0": "#d8dee9",
    "--mauve": "#b48ead", "--blue": "#88c0d0", "--sapphire": "#81a1c1",
    "--teal": "#8fbcbb", "--green": "#a3be8c", "--yellow": "#ebcb8b",
    "--peach": "#d08770", "--red": "#bf616a", "--pink": "#b48ead", "--flamingo": "#d08770",
  },
  "gruvbox-dark": {
    "--base": "#282828", "--mantle": "#1d2021", "--crust": "#141617",
    "--surface0": "#3c3836", "--surface1": "#504945", "--surface2": "#665c54",
    "--overlay0": "#928374", "--overlay1": "#a89984",
    "--text": "#ebdbb2", "--subtext1": "#d5c4a1", "--subtext0": "#bdae93",
    "--mauve": "#d3869b", "--blue": "#83a598", "--sapphire": "#458588",
    "--teal": "#8ec07c", "--green": "#b8bb26", "--yellow": "#fabd2f",
    "--peach": "#fe8019", "--red": "#fb4934", "--pink": "#d3869b", "--flamingo": "#cc241d",
  },
};

export function resolveTheme(theme: string | Record<string, string>): ThemeVars {
  if (typeof theme === "object") return { ...THEMES["catppuccin-mocha"]!, ...theme };
  return THEMES[theme] ?? THEMES["catppuccin-mocha"]!;
}

export function themeToCSS(vars: ThemeVars): string {
  return `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;
}
