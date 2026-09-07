import { useEffect, useRef, useState } from "react";
import type { ThinkMode } from "@vermillion/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";

export function useThinkMode(transport: DesktopTransport, sessionId?: string) {
  const [selection, setSelection] = useState<{ sessionId?: string; mode: ThinkMode }>({ mode: "dispatch" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const ready = selection.sessionId === sessionId && !saving;

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    if (!sessionId) {
      setSelection({ mode: "dispatch" });
      return;
    }
    void transport.chatTree.get(sessionId).then((tree) => {
      if (!cancelled) setSelection({ sessionId, mode: tree.thinkMode ?? "dispatch" });
    }).catch((cause: Error) => {
      if (!cancelled) setError(cause.message);
    });
    return () => { cancelled = true; };
  }, [transport, sessionId]);

  const choose = async (mode: ThinkMode) => {
    setSaving(true);
    setError(undefined);
    try {
      if (sessionId) await transport.chatTree.setMode({ sessionId, mode });
      if (currentSessionId.current === sessionId) setSelection({ sessionId, mode });
    } catch (cause) {
      if (currentSessionId.current === sessionId) setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return {
    mode: selection.sessionId === sessionId ? selection.mode : "dispatch" as ThinkMode,
    ready, error, choose,
    getSendOptions: () => {
      if (!ready) throw new Error("请等待模式加载或保存完成。");
      return { thinkMode: selection.mode };
    }
  };
}
