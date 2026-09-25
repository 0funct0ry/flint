import React from 'react';
import ReactDOM from 'react-dom/client';
import 'katex/dist/katex.min.css';
import { App } from './App';
import './index.css';

// Flint is a chromeless desktop app (SPEC §9.2) — it never relies on the host browser/webview's
// native context menu. The editor pane supplies its own real menu (M10.05); everywhere else in
// the window, the native "Reload / AutoFill / Inspect" menu would look and behave like a bug.
document.addEventListener('contextmenu', (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
