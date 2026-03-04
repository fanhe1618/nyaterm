import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_THEME_ID, type Theme, type ThemeColors, themeList, themes } from "../themes";
import { useApp } from "./AppContext";

interface ThemeContextType {
  theme: Theme;
  themeName: string;
  setTheme: (id: string) => void;
  themeNames: typeof themeList;
}

/**
 * Theme state: current theme object and name. setTheme updates local state and
 * persists via updateAppSettings. CSS vars applied to :root on theme change.
 */
const ThemeContext = createContext<ThemeContextType | null>(null);

export const THEME_CACHE_KEY = "df-theme-id";

/** Inject all theme colors as CSS custom properties on :root */
export function applyThemeToDOM(colors: ThemeColors) {
  const root = document.documentElement.style;
  root.setProperty("--df-bg", colors.bg);
  root.setProperty("--df-bg-panel", colors.bgPanel);
  root.setProperty("--df-bg-terminal", colors.bgTerminal);
  root.setProperty("--df-bg-hover", colors.bgHover);
  root.setProperty("--df-bg-input", colors.bgInput);
  root.setProperty("--df-bg-section-header", colors.bgSectionHeader);
  root.setProperty("--df-border", colors.border);
  root.setProperty("--df-text", colors.text);
  root.setProperty("--df-text-muted", colors.textMuted);
  root.setProperty("--df-text-dimmed", colors.textDimmed);
  root.setProperty("--df-primary", colors.primary);
  root.setProperty("--df-primary-hover", colors.primaryHover);
  root.setProperty("--df-scroll-thumb", colors.scrollThumb);
  root.setProperty("--df-accent", colors.accent);
}

/** Provides theme, themeName, setTheme. Syncs with appSettings.appearance.theme from backend. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { appSettings, updateAppSettings } = useApp();
  const initialId = appSettings.appearance.theme || DEFAULT_THEME_ID;
  const [themeName, setThemeName] = useState(initialId);

  const current = themes[themeName] || themes[DEFAULT_THEME_ID];

  // Apply CSS vars whenever theme changes and cache the ID
  useEffect(() => {
    applyThemeToDOM(current.colors);
    try { localStorage.setItem(THEME_CACHE_KEY, current.id); } catch {}
  }, [current]);

  // Sync from backend when appSettings.appearance.theme changes (e.g. on load or from Settings dialog)
  useEffect(() => {
    const configTheme = appSettings.appearance.theme;
    if (configTheme && configTheme !== themeName && themes[configTheme]) {
      setThemeName(configTheme);
    }
  }, [appSettings.appearance.theme, themeName]);

  const setTheme = useCallback(
    (id: string) => {
      if (themes[id]) {
        setThemeName(id);
        updateAppSettings({ appearance: { ...appSettings.appearance, theme: id } });
      }
    },
    [appSettings.appearance, updateAppSettings],
  );

  return (
    <ThemeContext.Provider value={{ theme: current, themeName, setTheme, themeNames: themeList }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** Hook to access ThemeContext. Throws if used outside ThemeProvider. */
export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
