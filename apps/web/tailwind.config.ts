import type { Config } from 'tailwindcss';

/**
 * The visual language: warm neutrals with a single deep teal accent, and one
 * amber reserved exclusively for "this number is modelled, not quoted". Giving
 * uncertainty its own colour means a traveller can see, at a glance, which
 * parts of a total are real prices.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#14211f',
          soft: '#3d4a47',
          faint: '#6b7875',
        },
        sand: {
          50: '#fbfaf7',
          100: '#f5f2ec',
          200: '#e9e4d9',
          300: '#d8d1c2',
        },
        teal: {
          500: '#0f6b60',
          600: '#0b564d',
          700: '#08423b',
        },
        clay: '#c0603c',
        /** Estimates and assumptions only. Never decorative. */
        estimate: '#a97516',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(20, 33, 31, 0.04), 0 8px 24px -12px rgba(20, 33, 31, 0.18)',
        lift: '0 2px 4px rgba(20, 33, 31, 0.06), 0 16px 40px -16px rgba(20, 33, 31, 0.28)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
      },
    },
  },
  plugins: [],
};

export default config;
