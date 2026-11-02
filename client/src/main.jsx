import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { APP_ICON } from './app-icon-data.js';

const favicon = document.querySelector('link[rel="icon"]');
if (favicon) favicon.href = APP_ICON;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
