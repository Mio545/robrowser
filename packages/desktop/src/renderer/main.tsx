/**
 * Renderer entry point (spec 9).
 *
 * Boots the React 18 application into `index.html`. No Node/Electron globals
 * are available here on purpose: everything privileged goes through the preload
 * bridge exposed as `window.robrowser`.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element in index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
