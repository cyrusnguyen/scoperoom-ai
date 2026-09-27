const paths = {
  panel: ["M3 3h18v18H3V3Zm5 0v18"],
  details: ["M3 3h18v18H3V3Zm13 0v18"],
  lock: ["M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4"],
  close: ["m6 6 12 12M6 18 18 6"],
  plus: ["M12 5v14M5 12h14"],
  more: ["M4 12h.01M12 12h.01M20 12h.01"],
} as const;

export type IconName = keyof typeof paths;

/** Decorative stroke icons from the Atlas Projects set; the control that holds one supplies the accessible name. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name].map((d) => <path key={d} d={d} />)}
  </svg>;
}
