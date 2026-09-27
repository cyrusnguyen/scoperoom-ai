const paths = {
  panel: ["M3 3h18v18H3V3Zm5 0v18"],
  details: ["M3 3h18v18H3V3Zm13 0v18"],
  lock: ["M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4"],
  close: ["m6 6 12 12M6 18 18 6"],
  plus: ["M12 5v14M5 12h14"],
  more: ["M4 12h.01M12 12h.01M20 12h.01"],
  flow: ["M9 3H3v6h6V3Zm12 12h-6v6h6v-6ZM6 9v9h9M9 6h9v9"],
  list: ["M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"],
  link: ["m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"],
  chevron: ["m8 10 4 4 4-4"],
  check: ["m5 12 4 4L19 6"],
  grid: ["M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z"],
  undo: ["M3 10h11a6 6 0 0 1 0 12M3 10l5-5m-5 5 5 5"],
} as const;

export type IconName = keyof typeof paths;

/** Decorative stroke icons from the Atlas Projects set; the control that holds one supplies the accessible name. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name].map((d) => <path key={d} d={d} />)}
  </svg>;
}
