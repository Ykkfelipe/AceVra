// Screen takeover glow driver (zcode-cua specs "Screen takeover").
//
// Reads the lease authority's global control status (the single owner) once per second and
// heartbeats `platform.setScreenTakeoverOverlay` while a takeover lease is active. Presentation
// only: the host hides the glow on its own when heartbeats stop, so a hung renderer can never
// leave it on after the takeover ended.
import { useEffect, useRef } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "./usePlatform.js";
import { useOptionalServices } from "./useServices.js";

export const SCREEN_TAKEOVER_POLL_MS = 1_000;

export function useScreenTakeoverOverlay(): void {
  const platform = usePlatform();
  const services = useOptionalServices();
  const cuaPermissionService = services?.cuaPermissionService;
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "screenTakeover.overlay.label" });
  const hint = intl.formatMessage({ id: "screenTakeover.overlay.hint" });
  const shownRef = useRef(false);

  useEffect(() => {
    const setOverlay = platform.setScreenTakeoverOverlay?.bind(platform);
    if (!cuaPermissionService || !setOverlay) return;
    let disposed = false;
    const tick = async (): Promise<void> => {
      let active = false;
      try {
        active = (await cuaPermissionService.getControlStatus()).state === "active";
      } catch {
        active = false;
      }
      if (disposed) return;
      if (active) {
        setOverlay({ active: true, label, hint });
        shownRef.current = true;
      } else if (shownRef.current) {
        setOverlay({ active: false });
        shownRef.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SCREEN_TAKEOVER_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (shownRef.current) setOverlay({ active: false });
      shownRef.current = false;
    };
  }, [cuaPermissionService, hint, label, platform]);
}
