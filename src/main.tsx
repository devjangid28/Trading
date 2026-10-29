import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

// Tells the boot fallback in index.html that the entry module executed, so it
// never shows the "did not finish starting" message over a page that is fine.
window.__ofBooted = true;

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary label="OrderFlow">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
