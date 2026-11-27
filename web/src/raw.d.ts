// Vite отдаёт файл строкой по суффиксу ?raw.
declare module '*.md?raw' {
  const text: string;
  export default text;
}
