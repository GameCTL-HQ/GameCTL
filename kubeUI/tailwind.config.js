/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  // v4 still supports plugin config here
  plugins: [require('@tailwindcss/forms')],
}
