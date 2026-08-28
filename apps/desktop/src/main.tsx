import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { HardwareProvider } from "./contexts/HardwareContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { bootstrapDocumentTheme } from "./services/app_theme";

// Apply the persisted mode before the first React paint.
bootstrapDocumentTheme();

// Disable Context Menu (Right Click) in Production
document.addEventListener('contextmenu', event => event.preventDefault());

// Disable F5 and Ctrl+R Refresh
document.addEventListener('keydown', (event) => {
  if (event.key === 'F5' || (event.ctrlKey && event.key === 'r') || (event.key === 'r' && event.metaKey)) {
    event.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ThemeProvider>
    {new URLSearchParams(window.location.search).get('console') === 'detached' ? (
      <App />
    ) : (
      <HardwareProvider>
        <App />
      </HardwareProvider>
    )}
  </ThemeProvider>
);
