import { LOCAL_ENGINEERING_ALPHA_RELEASE_PROFILE, ZCODE_RELEASE_PROFILE } from "@zcode/shared";

export function shouldShowComputerUseAlphaNotice({
  releaseProfile = ZCODE_RELEASE_PROFILE,
  enabled,
  toggling,
}: {
  releaseProfile?: string;
  enabled: boolean;
  toggling: boolean;
}): boolean {
  return releaseProfile === LOCAL_ENGINEERING_ALPHA_RELEASE_PROFILE && (!enabled || toggling);
}
