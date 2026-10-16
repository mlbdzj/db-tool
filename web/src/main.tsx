import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const storedTheme = localStorage.getItem('db-tool-theme');
document.documentElement.dataset.theme = storedTheme === 'light' ? 'light' : 'dark';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
