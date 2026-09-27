import { useEffect, useSyncExternalStore } from "react";
import { setLocale } from "../../i18n/index.js";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";

/** Changes whenever global settings change, from the settings page or the CLI. */
export const useSettingsSignal = (store: RendererStore): number =>
  useSyncExternalStore(
    (onChange) => store.subscribeMeta(onChange),
    () => store.getSubscriptionSnapshot().state.refreshSignals.settings
  );

/** Follows the saved interface language: settings changed from the settings page or the CLI switch it immediately. */
export const useLocaleSync = (store: RendererStore, transport: DesktopTransport): void => {
  const signal = useSettingsSignal(store);
  useEffect(() => {
    if (signal === 0) return;
    let cancelled = false;
    void transport.settings.get().then((settings) => {
      if (!cancelled) setLocale(settings.locale);
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [signal, transport]);
};
