import { useEffect, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";

/** Whether the engineering-only raw process runner may be shown (never in packaged builds). */
export function useAccountEngineeringTools(): boolean {
  const account = useOptionalPlatform()?.account;
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!account) return;
    let live = true;
    account
      .engineeringTools()
      .then((next) => live && setEnabled(next === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account]);
  return enabled;
}
