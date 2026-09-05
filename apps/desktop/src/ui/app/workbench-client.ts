import { createWorkbenchClient, type WorkbenchClient } from "@vermillion/workbench/client";

export const createRendererWorkbenchClient = (): WorkbenchClient => {
  const bridge = window.vermillion;
  if (!bridge) {
    throw new Error("The Vermillion preload bridge is missing.");
  }
  return createWorkbenchClient(bridge);
};
