/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        panel: 'var(--panel)',
        'panel-2': 'var(--panel-2)',
        border: 'var(--border)',
        text: 'var(--text)',
        'text-2': 'var(--text-2)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        spark: 'var(--spark)',
        sel: 'var(--sel)',
      },
      fontFamily: {
        ui: ['var(--ui)', 'system-ui', 'sans-serif'],
        mono: ['var(--mono)', 'monospace'],
      },
    },
  },
  plugins: [],
}
