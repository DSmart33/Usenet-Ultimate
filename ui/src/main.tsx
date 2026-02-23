// What this does:
//      Imports React and our App component
//      createRoot() - New React 18 API for concurrent rendering
//      StrictMode - Helps catch bugs during development
//      Renders <App /> into the #root div

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Prevent iOS standalone-PWA native pull-to-refresh.
// CSS overscroll-behavior handles modern browsers; this catches older iOS.
if ('standalone' in navigator || window.matchMedia('(display-mode: standalone)').matches) {
  let startY = 0;
  document.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[class*="overflow-y-auto"], [class*="overflow-auto"]') as HTMLElement | null : null;
    if (el && el.scrollTop <= 0 && e.touches[0].clientY > startY) {
      e.preventDefault();
    }
  }, { passive: false });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);