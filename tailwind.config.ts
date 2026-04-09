import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          900: '#0d1117',
          800: '#161b22',
          700: '#21262d',
          600: '#30363d',
        },
        regime: {
          trending: '#16a34a',
          ranging: '#d97706',
          highvol: '#dc2626',
          lowvol: '#2563eb',
          transitional: '#6b7280',
        },
      },
    },
  },
  plugins: [],
};

export default config;
