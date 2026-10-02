// Drag/resize gestures for the floating LocalComputerPreview window.
//
// 纯呈现交互：拖动/缩放只在本地状态里跟手（transform/width），松手时一次性提交到呈现
// store；不触碰会话事实，也不会让窗口流重启。坐标始终按当前视口夹紧。
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  clampPreviewPosition,
  clampPreviewWidth,
  frameHeightFor,
  PREVIEW_CHROME_HEIGHT,
  type PreviewPoint,
  type PreviewRect,
} from "./localPreviewGeometry.js";

interface Gesture {
  kind: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  rect: PreviewRect;
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function usePreviewWindowGestures(input: {
  rect: PreviewRect;
  aspectRatio: number | null;
  enabled: boolean;
  onMove: (position: PreviewPoint) => void;
  onResize: (width: number, position: PreviewPoint) => void;
}) {
  const { rect, aspectRatio, enabled, onMove, onResize } = input;
  const gesture = useRef<Gesture | null>(null);
  const [live, setLiveState] = useState<PreviewRect | null>(null);
  // 提交时读取最新跟手值；不在 setState updater 里做副作用（StrictMode 会重复调用 updater）。
  const liveRef = useRef<PreviewRect | null>(null);
  const setLive = useCallback((next: PreviewRect | null) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  const begin = useCallback(
    (kind: Gesture["kind"]) => (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return;
      // 标题栏上的按钮自己处理点击，绝不开始拖动。
      if (kind === "move" && (event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        rect,
      };
      setLive(rect);
    },
    [enabled, rect, setLive],
  );

  const move = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (current.kind === "move") {
        const height = current.rect.frameHeight + PREVIEW_CHROME_HEIGHT;
        const position = clampPreviewPosition(
          { x: current.rect.x + dx, y: current.rect.y + dy },
          { width: current.rect.width, height },
          viewport(),
        );
        setLive({ ...current.rect, ...position });
        return;
      }
      // 右下角缩放：左上角不动，只改宽度；高度跟随画面宽高比。
      const width = clampPreviewWidth(current.rect.width + dx, viewport());
      setLive({ ...current.rect, width, frameHeight: frameHeightFor(width, aspectRatio) });
    },
    [aspectRatio, setLive],
  );

  const end = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const final = liveRef.current;
      setLive(null);
      if (!final) return;
      if (current.kind === "move") {
        onMove({ x: final.x, y: final.y });
        return;
      }
      const height = final.frameHeight + PREVIEW_CHROME_HEIGHT;
      onResize(
        final.width,
        clampPreviewPosition(final, { width: final.width, height }, viewport()),
      );
    },
    [onMove, onResize, setLive],
  );

  const handlers = (kind: Gesture["kind"]) => ({
    onPointerDown: begin(kind),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  return {
    /** The rect to render: the live gesture rect while dragging/resizing, else the stored one. */
    rect: live ?? rect,
    active: live !== null,
    dragHandlers: handlers("move"),
    resizeHandlers: handlers("resize"),
  };
}
