import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initTheme } from './ui/ThemeToggle';
import './styles/global.css';

initTheme(); // before first paint — no theme flash

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
