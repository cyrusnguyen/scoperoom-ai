type PanelSide = "left" | "right";

const panelKey = (side: PanelSide) => `scoperoom_${side}_open`;

export function rememberPanel(side: PanelSide, open: boolean) {
  try { sessionStorage.setItem(panelKey(side), open ? "1" : "0"); } catch { /* The controls still work if storage is unavailable. */ }
}

export function restorePanel(side: PanelSide) {
  const key = panelKey(side);
  let stored: string | null = null;
  try { stored = sessionStorage.getItem(key); } catch { /* Use the default open state. */ }
  if (stored === null) {
    const legacy = document.cookie.split("; ").find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
    if (legacy === "0" || legacy === "1") {
      stored = legacy;
      try { sessionStorage.setItem(key, legacy); } catch { /* Keep the state for this load. */ }
    }
  }
  document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax`;
  return stored !== "0";
}
