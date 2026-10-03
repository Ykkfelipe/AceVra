/**
 * RemoteComputer（acevra-agent-computer.md §3.5）的工具卡。
 *
 * 聊天主流的截图投影在 ConversationComputerImages（image 通道）；本卡只补上
 * observationImage 通道——agent 自查用的截图在卡片详情里出一张缩略图，可点开放大。
 * 其余渲染完全复用 fallback 卡。
 */
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { CuaScreenshotSection } from "@/ToolCallBlocks/renderers/CuaScreenshotSection.js";
import type { CuaScreenshotDetails } from "@/ToolCallBlocks/renderers/cuaScreenshotDetails.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

function readObservationScreenshot(
  context: ToolCallBlockRenderContext,
): CuaScreenshotDetails | undefined {
  const display = readToolResultDisplay(context.toolCallNode.toolCall.raw);
  if (display?.kind !== "remote_computer" || !display.observationImage) return undefined;
  const { base64, mimeType } = display.observationImage;
  return {
    dataUrl: `data:${mimeType};base64,${base64}`,
    width: null,
    height: null,
    mimeType,
    fullScreen: true,
    zoom: false,
    region: null,
    clamped: false,
  };
}

export function RemoteComputerToolCallBlock(context: ToolCallBlockRenderContext) {
  const screenshot = readObservationScreenshot(context);
  if (!screenshot) return <FallbackToolCallBlock {...context} />;
  return (
    <>
      <FallbackToolCallBlock {...context} />
      <div className="px-4 pb-3">
        <CuaScreenshotSection screenshot={screenshot} />
      </div>
    </>
  );
}
