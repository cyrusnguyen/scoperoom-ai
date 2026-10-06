import type { Locator } from "@playwright/test";

export async function privateBrowserInput(action: () => Promise<unknown>): Promise<void> {
  try { await action(); }
  catch { throw new Error("Could not enter a private authentication field."); }
}

export function fillPrivateField(locator: Locator, value: string): Promise<void> {
  return privateBrowserInput(() => locator.fill(value));
}
