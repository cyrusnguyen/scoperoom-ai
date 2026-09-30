"use client";

import { useEffect, useMemo, useState } from "react";
import { ViewportPortal } from "@xyflow/react";
import { expiryDelay, sessionLabels, visibleDrags } from "./live-canvas";
import { useParticipants } from "./use-participants";
import { useSync, type PreviewSnapshot } from "./sync-context";

/**
 * The remote previews, re-read on every store notification and by ONE timer for the nearest expiry (expiry only shows on a
 * read). The timer is armed once and never reset by notifications, so a steady roster cannot starve it; it is not the status timer.
 */
function usePreviewSnapshot(): PreviewSnapshot {
  const { previews } = useSync();
  const [shot, setShot] = useState(previews.snapshot);
  useEffect(() => {
    let timer: number | undefined, notifiedAt = Date.now();
    const arm = (next: PreviewSnapshot) => {
      const delay = expiryDelay(next, notifiedAt, Date.now());
      if (delay === null || timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; arm(read()); }, delay);
    };
    const read = () => { const next = previews.snapshot(); setShot(next); return next; };
    const unsubscribe = previews.subscribe(() => { notifiedAt = Date.now(); arm(read()); });
    arm(read());
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [previews]);
  return shot;
}

/**
 * Other people's cursors and drag ghosts, drawn in flow space under the viewport transform as pointer-events-none outlines. They
 * are advisory pictures: never a React Flow node position, never saved, and hidden from assistive technology, outside any
 * live region (a peer's cursor never announces). Under reduced motion they are static outlines (CSS).
 */
export default function LiveOverlay({ flowId, localDragging, sizeOf }: { flowId: string; localDragging: ReadonlySet<string>; sizeOf: (nodeId: string) => { width: number; height: number } }) {
  const shot = usePreviewSnapshot();
  const { roster, status: { viewerId } } = useSync();
  const { people } = useParticipants(flowId);
  const labels = useMemo(() => sessionLabels(roster, people, viewerId), [roster, people, viewerId]);
  const drags = visibleDrags(shot, localDragging);
  if (!shot.cursors.length && !drags.length) return null;
  const label = (sessionId: string) => labels.get(sessionId) ?? { name: "Unknown participant", color: 0 };
  return <ViewportPortal>
    <div className="live-overlay" aria-hidden="true">
      {drags.flatMap((drag) => drag.items.map((item) => {
        const { name, color } = label(drag.sessionId);
        const { width, height } = sizeOf(item.nodeId);
        return <div key={`${drag.sessionId}-${item.nodeId}`} className="live-ghost" data-presence={color} data-node-id={item.nodeId} style={{ width, height, transform: `translate(${item.x}px, ${item.y}px)` }}>
          <span className="live-label"><span>{name}</span></span>
        </div>;
      }))}
      {shot.cursors.map((cursor) => {
        const { name, color } = label(cursor.sessionId);
        return <div key={cursor.sessionId} className="live-cursor" data-presence={color} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}>
          <span className="live-cursor-mark" />
          <span className="live-label"><span>{name}</span></span>
        </div>;
      })}
    </div>
  </ViewportPortal>;
}
