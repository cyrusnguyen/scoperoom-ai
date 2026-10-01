"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore, ViewportPortal } from "@xyflow/react";
import { expiryDelay, sessionLabels, visibleDrags } from "./live-canvas";
import { UNKNOWN_PARTICIPANT } from "./participants";
import { useParticipants } from "./use-participants";
import { useSync, type PreviewSnapshot } from "./sync-context";

/**
 * The remote previews, re-read on every store notification and by ONE timer armed at the earliest shown entry's expiry (expiry
 * only shows on a read). Each read re-arms it, so it always targets the current earliest expiry; it is not the status timer.
 */
function usePreviewSnapshot(): PreviewSnapshot {
  const { previews } = useSync();
  const [shot, setShot] = useState(previews.snapshot);
  useEffect(() => {
    let timer: number | undefined;
    const read = () => {
      window.clearTimeout(timer);
      const now = Date.now(); // one reading for both, or an entry expiring between them is shown with no timer
      setShot(previews.snapshot(now));
      const delay = expiryDelay(previews.nextExpiry(now), now);
      timer = delay === null ? undefined : window.setTimeout(read, delay);
    };
    const unsubscribe = previews.subscribe(read);
    read();
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [previews]);
  return shot;
}

/**
 * Other people's cursors and drag ghosts, drawn in flow space under the viewport transform as pointer-events-none outlines. They
 * are advisory pictures: never a React Flow node position, never saved, and hidden from assistive technology, outside any
 * live region (a peer's cursor never announces). Cursors and labels keep a constant screen size at any zoom; ghost outlines stay in flow units. Under reduced motion they are static outlines (CSS).
 */
export default function LiveOverlay({ localDragging, sizeOf }: { localDragging: ReadonlySet<string>; sizeOf: (nodeId: string) => { width: number; height: number } }) {
  const shot = usePreviewSnapshot();
  const { roster, status: { viewerId } } = useSync();
  const { people } = useParticipants();
  const zoom = useStore((state) => state.transform[2]);
  const labels = useMemo(() => sessionLabels(roster, people, viewerId), [roster, people, viewerId]);
  const drags = visibleDrags(shot, localDragging);
  if (!shot.cursors.length && !drags.length) return null;
  const label = (sessionId: string) => labels.get(sessionId) ?? { name: UNKNOWN_PARTICIPANT, color: 0 };
  return <ViewportPortal>
    <div className="live-overlay" aria-hidden="true">
      {drags.flatMap((drag) => drag.items.map((item) => {
        const { name, color } = label(drag.sessionId);
        const { width, height } = sizeOf(item.nodeId);
        return <div key={`${drag.sessionId}-${item.nodeId}`} className="live-ghost" data-presence={color} data-node-id={item.nodeId} style={{ width, height, transform: `translate(${item.x}px, ${item.y}px)` }}>
          <span className="live-label" style={{ transform: `scale(${1 / zoom}) translateY(-100%)` }}><span>{name}</span></span>
        </div>;
      }))}
      {shot.cursors.map((cursor) => {
        const { name, color } = label(cursor.sessionId);
        return <div key={cursor.sessionId} className="live-cursor" data-presence={color} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px) scale(${1 / zoom})` }}>
          <span className="live-cursor-mark" />
          <span className="live-label"><span>{name}</span></span>
        </div>;
      })}
    </div>
  </ViewportPortal>;
}
