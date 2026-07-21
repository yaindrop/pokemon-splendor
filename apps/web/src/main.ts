import './style.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppOverlays } from './react/AppOverlays.js';

const overlayRoot = document.querySelector<HTMLElement>('#react-root');
if (!overlayRoot) throw new Error('缺少 React 覆盖层挂载点：#react-root');

createRoot(overlayRoot).render(createElement(AppOverlays));

await import('./ui.js');
await import('./tutorial.js');
