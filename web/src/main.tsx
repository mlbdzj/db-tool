import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const storedTheme = localStorage.getItem('db-tool-theme');
const systemPrefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
// Follow the system until the user picks a theme explicitly.
document.documentElement.dataset.theme =
  storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : systemPrefersLight ? 'light' : 'dark';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
