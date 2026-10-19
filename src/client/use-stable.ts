import { useLayoutEffect, useState } from "react";

/** The same functions on every render, always calling the latest ones, for a child that memoizes on handler identity. */
export function useStable<T extends object>(handlers: T): T {
  const [relay] = useState(() => {
    let latest = handlers;
    const stable = Object.fromEntries(Object.keys(handlers).map((key) => [key, (...args: unknown[]) => (latest[key as keyof T] as (...args: unknown[]) => unknown)(...args)])) as T;
    return { stable, set: (next: T) => { latest = next; } };
  });
  useLayoutEffect(() => relay.set(handlers));
  return relay.stable;
}
