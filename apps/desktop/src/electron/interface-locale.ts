import type { Locale } from "@vermillion/shared";
import type { createSessionRuntimeService } from "@vermillion/desktop-server";

/** The saved interface language, for text the main process shows to the user (notifications, generated titles). */
export const interfaceLocale = async (service: ReturnType<typeof createSessionRuntimeService>): Promise<Locale> =>
  (await service.getSettings()).locale;
