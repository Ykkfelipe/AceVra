import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";

export function RootShell({ children }: { children: ReactNode }) {
  // 手机动态视口高度由根节点 #root（100dvh，styles.css）拥有；
  // RootShell 只跟随容器高度。自声明 h-dvh 会在 /fork banner 缩短 app 行后
  // 让整棵树超出容器、底边（含侧栏 footer）被 overflow:hidden 裁切。
  return (
    <div className="relative h-full min-h-0">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
    </div>
  );
}
