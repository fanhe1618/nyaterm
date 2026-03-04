import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource-variable/noto-sans-sc";
import "./i18n";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";
import { AppProvider } from "./context/AppContext";
import { applyThemeToDOM, THEME_CACHE_KEY, ThemeProvider } from "./context/ThemeContext";
import { themes, DEFAULT_THEME_ID } from "./themes";

// Apply cached theme synchronously before React renders to avoid flash
try {
  const cachedId = localStorage.getItem(THEME_CACHE_KEY);
  const theme = (cachedId && themes[cachedId]) || themes[DEFAULT_THEME_ID];
  applyThemeToDOM(theme.colors);
} catch {}

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
