export {};
declare global {
  interface Window {
    __VERMILLION_REMOTE__?: { token: string };
    webkit?: { messageHandlers?: { vermillion?: { postMessage: (message: { type: "exit" }) => void } } };
  }
}
