import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { NodeReplImageGrid } from "@/ToolCallBlocks/renderers/nodeReplImageGrid.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Delivered Computer images are user-visible results, independent of history expansion. */
export function ConversationComputerImages({ rows }: { rows: readonly ConversationRow[] }) {
  const { intl } = useZCodeIntl();
  const resultImageLabel = intl.formatMessage({ id: "chat.toolCall.nodeRepl.resultImage" });
  return (
    <>
      {rows.map((row) => {
        if (
          row.kind !== "toolCall" ||
          row.display?.kind !== "node_repl_images" ||
          !row.display.cuaOperation ||
          row.display.source === "browser_turn_end" ||
          !row.display.images?.length
        )
          return null;
        // 修复依据：真实 screenshot 已进入持久化 display，但被两层折叠隐藏；
        // 只投影宿主实际交付的图片，不依据模型的“截图成功”文字生成结果。
        return (
          <div key={row.rowId} data-computer-screenshot-result="" className="py-2">
            <NodeReplImageGrid images={row.display.images} resultImageLabel={resultImageLabel} />
          </div>
        );
      })}
    </>
  );
}
