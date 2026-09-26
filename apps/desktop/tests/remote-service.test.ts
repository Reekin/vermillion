import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RemoteAccessService } from "../src/electron/remote/service.js";

it("pairs using the HTTPS port rather than the FRP backend and retains settings across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-service-"));
  const create = () => new RemoteAccessService(directory, {
    assetsDir: directory, createRouter: () => ({ handleRequest: async () => ({}), dispose: async () => {} }),
    workbenchRequest: async () => ({}), subscribeWorkbench: () => () => {}, summary: async () => ({})
  });
  let service = create();
  try {
    await service.initialize();
    const result = await service.handleRequest({ method: "remote.configure", params: { patch: {
      enabled: true, serverAddr: "203.0.113.10", frpToken: "test-only", remotePort: 18001,
      publicPort: 8443, frpcPath: join(directory, "missing-frpc")
    } } });
    expect(result.ok).toBe(true);
    const pair = await service.handleRequest({ method: "remote.pair", params: {} });
    expect(pair.ok).toBe(true);
    if (pair.ok) expect(new URL((pair.result as { qrContent: string }).qrContent).searchParams.get("url")).toBe("https://203.0.113.10:8443");
    expect(service.status().state).toBe("error");
    await service.dispose();
    service = create();
    await service.initialize();
    expect(service.getConfig()).toMatchObject({ publicPort: 8443, remotePort: 18001 });
    await service.handleRequest({ method: "remote.configure", params: { patch: { enabled: false } } });
    expect(service.status()).toMatchObject({ state: "disabled", connectedDevices: 0 });
    expect(service.status().gatewayPort).toBeUndefined();
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
