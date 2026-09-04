import React from "react";
import ReactDOM from "react-dom/client";
import { createRendererStore } from "../store/store.js";
import {
  createDesktopTransport,
  type DesktopTransport
} from "../transport/desktop-transport.js";
import { App } from "./app/App.js";
import { RendererErrorBoundary } from "./RendererErrorBoundary.js";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element.");
}

const describeUnknownError = (error: unknown): { message: string; stack?: string } => {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: typeof error === "string" ? error : String(error)
  };
};

const installRendererErrorLogging = (transport: DesktopTransport): void => {
  window.addEventListener("error", (event) => {
    const details = describeUnknownError(event.error ?? event.message);
    void transport.errorLog.write({
      message: details.message,
      severity: "error",
      source: "renderer-error",
      stack: details.stack,
      context: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      }
    }).catch(() => undefined);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const details = describeUnknownError(event.reason);
    void transport.errorLog.write({
      message: details.message,
      severity: "error",
      source: "renderer-unhandled-rejection",
      stack: details.stack
    }).catch(() => undefined);
  });
};

let transport: ReturnType<typeof createDesktopTransport> | undefined;
try {
  if (!window.workbench) {
    throw new Error(
      "The Electron preload API is missing. Launch Vermillion through the desktop application."
    );
  }
  transport = createDesktopTransport(window.workbench);
  installRendererErrorLogging(transport);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = [
    "<main style='font-family: ui-sans-serif, system-ui; padding: 24px; line-height: 1.5'>",
    "<h1 style='margin: 0 0 12px'>Vermillion</h1>",
    "<p style='margin: 0 0 12px'>This production renderer requires the local Electron preload API.</p>",
    `<pre style='background: #f6f6f6; padding: 12px; border-radius: 8px; overflow: auto'>${message}</pre>`,
    "</main>"
  ].join("");
}

if (transport) {
  const store = createRendererStore();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RendererErrorBoundary transport={transport}>
        <App sessionStore={store} transport={transport} />
      </RendererErrorBoundary>
    </React.StrictMode>
  );
}
