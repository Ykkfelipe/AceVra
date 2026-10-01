import { useEffect, useRef } from "react";
import { mapRemoteToView } from "./computerInput.js";
import type { StreamCursor } from "./computerFrameStream.js";

/**
 * 远端光标 overlay（spec §4.5）：位置来自 cursor 事件流（cursorRef，24Hz 级更新），
 * rAF 循环直接改 DOM——高频更新不进入 React 渲染树；无事件时退回帧内嵌位置。
 */
export function ComputerCursorOverlay(props: {
  frame: { screenWidth: number; screenHeight: number; cursorX: number; cursorY: number } | null;
  imageRef: React.RefObject<HTMLImageElement | null>;
  cursorRef: React.RefObject<StreamCursor | null>;
  cursorVersionRef: React.RefObject<number>;
}) {
  const { frame, imageRef, cursorRef, cursorVersionRef } = props;
  const dotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let seen = -1;
    const tick = () => {
      const point = cursorRef.current;
      if (point && seen !== cursorVersionRef.current) {
        seen = cursorVersionRef.current;
        const image = imageRef.current;
        const dot = dotRef.current;
        if (image && dot && frame) {
          const view = mapRemoteToView(
            { x: point.x, y: point.y },
            { width: image.clientWidth, height: image.clientHeight },
            { width: frame.screenWidth, height: frame.screenHeight },
          );
          if (view) {
            dot.style.left = `${image.offsetLeft + view.x}px`;
            dot.style.top = `${image.offsetTop + view.y}px`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cursorRef, cursorVersionRef, frame, imageRef]);

  if (!frame) return null;
  const fallback = { x: frame.cursorX, y: frame.cursorY };
  return (
    <span
      ref={dotRef}
      aria-hidden="true"
      className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black bg-white"
      style={{
        left: (imageRef.current?.offsetLeft ?? 0) + fallback.x,
        top: (imageRef.current?.offsetTop ?? 0) + fallback.y,
      }}
    />
  );
}
