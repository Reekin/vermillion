export {};
declare global {
  interface Window {
    __VERMILLION_REMOTE__?: { token: string };
    /** Native App bridge: leave to the desktop list, or report whether the page shows a list or a session. */
    webkit?: { messageHandlers?: { vermillion?: { postMessage: (message: { type: "exit" } | { type: "level"; level: "list" | "session" }) => void } } };
  }
}
