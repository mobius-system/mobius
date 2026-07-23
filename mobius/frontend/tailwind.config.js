export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['class', 'dark'],
  theme: {
    extend: {
      colors: {
        bg: {
          dark: { 0: '#0B0F17', 1: '#111827', 2: '#1F2937', 3: '#374151' },
          light: { 0: '#FFFFFF', 1: '#F9FAFB', 2: '#F3F4F6', 3: '#E5E7EB' },
          0: '#0B0F17',
          1: '#111827',
          2: '#1F2937',
          3: '#374151',
        },
        accent: { DEFAULT: '#3B82F6', hover: '#2563EB', light: '#1D4ED8' },
        tool: { bash: '#10B981', edit: '#8B5CF6', read: '#6366F1', web: '#F59E0B', agent: '#EC4899' },
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Noto Sans SC', 'monospace'],
      },
    },
  },
  plugins: [],
}
