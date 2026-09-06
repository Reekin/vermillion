import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import type { ChatSession, SessionWindowRpc } from "@vermillion/shared";
import type { RendererStore } from "../../store/store.js";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";
import type { TranscriptViewportController } from "./use-transcript-viewport-controller.js";

type StatusNoticeSetter = Dispatch<
  SetStateAction<ComposerStatusNotice | undefined>
>;

type SessionWindowHydrationOptions = {
  forceProviderHydration?: boolean;
  preserveViewport?: boolean;
};

export type SessionWindowCoverage = Omit<SessionWindowRpc, "snapshot">;

export const canActivateCachedSessionWindow = (input: {
  window: SessionWindowCoverage | undefined;
  session: ChatSession | undefined;
}): boolean => {
  if (!input.window) {
    return false;
  }
  const isProviderSession = Boolean(
    input.session?.metadata?.providerKind &&
      input.session.metadata.providerSessionId
  );
  return !isProviderSession;
};

const toSessionWindowCoverage = (
  page: SessionWindowRpc
): SessionWindowCoverage => {
  const { snapshot: _snapshot, ...coverage } = page;
  return coverage;
};

export const useSessionOpenController = (input: {
  store: RendererStore;
  transport: DesktopTransport;
  sessionWindows: Record<string, SessionWindowCoverage | undefined>;
  setSessionWindows: Dispatch<
    SetStateAction<Record<string, SessionWindowCoverage | undefined>>
  >;
  loadingOlderSessionId?: string;
  setLoadingOlderSessionId: Dispatch<SetStateAction<string | undefined>>;
  openingSessionId?: string;
  setOpeningSessionId: Dispatch<SetStateAction<string | undefined>>;
  displayedSessionId?: string;
  activeSessionWindow?: SessionWindowCoverage;
  isOpeningSelectedSession: boolean;
  viewport: TranscriptViewportController;
  onResetSessionSwitchState: () => void;
  onStatusNotice: StatusNoticeSetter;
}): {
  activatedSessionId?: string;
  reloadSessionWindow: (
    sessionId: string,
    options?: SessionWindowHydrationOptions
  ) => Promise<void>;
  refreshDisplayedSessionWindow: (
    sessionId: string,
    options?: SessionWindowHydrationOptions
  ) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  openSession: (sessionId: string) => Promise<void>;
} => {
  const [activatedSessionId, setActivatedSessionId] = useState<string>();
  const openSessionRequestIdRef = useRef(0);
  const backgroundRefreshRequestIdRef = useRef(0);
  const manualSessionOpenTokenRef = useRef(0);
  const manualSessionOpenInFlightRef = useRef(false);

  const beginManualSessionOpen = (): number => {
    manualSessionOpenInFlightRef.current = true;
    manualSessionOpenTokenRef.current += 1;
    backgroundRefreshRequestIdRef.current += 1;
    return manualSessionOpenTokenRef.current;
  };

  const finishManualSessionOpen = (token: number): void => {
    if (manualSessionOpenTokenRef.current === token) {
      manualSessionOpenInFlightRef.current = false;
    }
  };

  const activateLoadedSession = (sessionId: string): boolean => {
    const session = input.store.getDomainReadModel().getSession(sessionId);
    if (!session) {
      return false;
    }
    input.store.dispatch({
      type: "store/setActiveConversation",
      conversationId: session.conversationId
    });
    input.store.dispatch({
      type: "store/setActiveSession",
      sessionId
    });
    setActivatedSessionId(sessionId);
    return true;
  };

  const applySessionWindow = (
    page: SessionWindowRpc,
    mode: "replace" | "prepend" = "replace",
    options: {
      activate?: boolean;
      preserveViewport?: boolean;
    } = {}
  ): void => {
    input.store.hydrateSessionWindow(
      page.sessionId,
      page.snapshot,
      mode,
      page.cursor
    );
    input.setSessionWindows((current) => {
      const existing = current[page.sessionId];
      if (mode === "prepend" && existing?.sessionId === page.sessionId) {
        return {
          ...current,
          [page.sessionId]: {
            ...existing,
            windowStartTurnId: page.windowStartTurnId ?? existing.windowStartTurnId,
            olderCursor: page.olderCursor,
            newerCursor: existing.newerCursor ?? page.newerCursor,
            hasOlder: page.hasOlder,
            hasNewer: existing.hasNewer
          }
        };
      }
      return {
        ...current,
        [page.sessionId]: toSessionWindowCoverage(page)
      };
    });
    if (mode === "replace" && !options.preserveViewport) {
      input.viewport.queueViewportTarget({
        sessionId: page.sessionId,
        type: page.windowEndTurnId && page.hasNewer ? "turn" : "bottom",
        turnId: page.windowEndTurnId && page.hasNewer ? page.windowEndTurnId : undefined
      });
    }
    if (options.activate ?? true) {
      activateLoadedSession(page.sessionId);
    }
  };

  const hydrateOpenedSession = async (
    sessionId: string,
    requestId: number,
    options: SessionWindowHydrationOptions = {}
  ): Promise<void> => {
    const result = await input.transport.sessionBrowser.open(sessionId, {
      forceProviderHydration: options.forceProviderHydration
    });
    if (openSessionRequestIdRef.current !== requestId) {
      return;
    }
    applySessionWindow(result.page, "replace", {
      preserveViewport: options.preserveViewport
    });
  };

  useEffect(() => {
    if (!input.openingSessionId) {
      return;
    }
    if (!input.sessionWindows[input.openingSessionId]) {
      return;
    }
    input.setOpeningSessionId((current) =>
      current === input.openingSessionId ? undefined : current
    );
    input.onStatusNotice((current) =>
      current?.source === "session-browser" ? undefined : current
    );
  }, [
    input.openingSessionId,
    input.sessionWindows,
    input.setOpeningSessionId,
    input.onStatusNotice
  ]);

  return {
    activatedSessionId,
    reloadSessionWindow: async (
      sessionId: string,
      options: SessionWindowHydrationOptions = {}
    ) => {
      const manualOpenToken = beginManualSessionOpen();
      const requestId = ++openSessionRequestIdRef.current;
      try {
        await hydrateOpenedSession(sessionId, requestId, options);
      } finally {
        finishManualSessionOpen(manualOpenToken);
      }
    },
    refreshDisplayedSessionWindow: async (
      sessionId: string,
      options: SessionWindowHydrationOptions = {}
    ) => {
      if (manualSessionOpenInFlightRef.current) {
        return;
      }
      if (input.viewport.displayedSessionIdRef.current !== sessionId) {
        return;
      }
      const requestId = ++backgroundRefreshRequestIdRef.current;
      const result = await input.transport.sessionBrowser.open(sessionId, {
        forceProviderHydration: options.forceProviderHydration
      });
      if (backgroundRefreshRequestIdRef.current !== requestId) {
        return;
      }
      if (
        manualSessionOpenInFlightRef.current ||
        input.viewport.displayedSessionIdRef.current !== sessionId
      ) {
        return;
      }
      applySessionWindow(result.page, "replace", {
        activate: false,
        preserveViewport: options.preserveViewport ?? true
      });
    },
    onLoadOlder: async () => {
      if (
        !input.displayedSessionId ||
        !input.activeSessionWindow?.hasOlder ||
        !input.activeSessionWindow.windowStartTurnId ||
        input.loadingOlderSessionId === input.displayedSessionId ||
        input.isOpeningSelectedSession
      ) {
        return;
      }

      const element = input.viewport.transcriptRef.current;
      const previousScrollHeight = element?.scrollHeight ?? 0;
      const previousScrollTop = element?.scrollTop ?? 0;
      input.setLoadingOlderSessionId(input.displayedSessionId);
      try {
        const result = await input.transport.sessionBrowser.loadOlder({
          sessionId: input.displayedSessionId,
          beforeTurnId: input.activeSessionWindow.windowStartTurnId,
          cursor: input.activeSessionWindow.olderCursor,
          limit: 8
        });
        if (input.viewport.displayedSessionIdRef.current !== input.displayedSessionId) {
          return;
        }
        input.viewport.queuePrependScrollRestore({
          sessionId: input.displayedSessionId,
          previousScrollHeight,
          previousScrollTop
        });
        applySessionWindow(result.page, "prepend", {
          activate: false
        });
      } catch (error) {
        input.onStatusNotice({
          message: `Load earlier turns failed: ${(error as Error).message}`,
          persistent: true,
          source: "session-browser",
          ...statusNoticeErrorDetails(error)
        });
      } finally {
        input.setLoadingOlderSessionId((current) =>
          current === input.displayedSessionId ? undefined : current
        );
      }
    },
    openSession: async (sessionId: string) => {
      const manualOpenToken = beginManualSessionOpen();
      const requestId = ++openSessionRequestIdRef.current;
      const previousSessionId = input.viewport.displayedSessionIdRef.current;
      input.onResetSessionSwitchState();
      input.setOpeningSessionId(sessionId);
      try {
        if (previousSessionId && previousSessionId !== sessionId) {
          input.viewport.clearPendingViewportState();
        }
        const cachedWindow = input.sessionWindows[sessionId];
        const domain = input.store.getDomainReadModel();
        const canActivateCachedWindow = canActivateCachedSessionWindow({
          window: cachedWindow,
          session: domain.getSession(sessionId)
        });
        if (canActivateCachedWindow && activateLoadedSession(sessionId)) {
          input.viewport.scrollToBottom(sessionId, {
            allowPendingForInactive: true
          });
          await input.transport.sessionBrowser.activate(sessionId);
          if (openSessionRequestIdRef.current !== requestId) {
            return;
          }
          input.setOpeningSessionId(undefined);
          input.onStatusNotice(undefined);
          return;
        }
        input.onStatusNotice({
          message: "Opening session…",
          persistent: true,
          source: "session-browser"
        });
        await hydrateOpenedSession(sessionId, requestId);
        if (openSessionRequestIdRef.current !== requestId) {
          return;
        }
        input.setOpeningSessionId(undefined);
        input.onStatusNotice(undefined);
      } catch (error) {
        if (openSessionRequestIdRef.current !== requestId) {
          return;
        }
        input.setOpeningSessionId(undefined);
        input.onStatusNotice({
          message: `Open session failed: ${(error as Error).message}`,
          persistent: true,
          source: "session-browser",
          ...statusNoticeErrorDetails(error)
        });
      } finally {
        finishManualSessionOpen(manualOpenToken);
      }
    }
  };
};
