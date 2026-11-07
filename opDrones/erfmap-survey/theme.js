'use strict';
const themeKey = 'erfmap-survey-theme';
let initialTheme = 'dark';
try {
    initialTheme = localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark';
} catch { /* Storage may be unavailable. */ }

function setTheme(theme) {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.documentElement.style.colorScheme = theme;
    document.getElementById('lightMode').setAttribute('aria-pressed', String(theme === 'light'));
    document.getElementById('darkMode').setAttribute('aria-pressed', String(theme === 'dark'));
    document.getElementById('styleControl').textContent = theme === 'light' ? '3D · Color' : '3D · Monochrome';
    try { localStorage.setItem(themeKey, theme); } catch { /* Keep the mode for this visit. */ }
}

setTheme(initialTheme);
document.getElementById('lightMode').addEventListener('click', () => setTheme('light'));
document.getElementById('darkMode').addEventListener('click', () => setTheme('dark'));
