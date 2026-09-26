import { z } from "zod";

const zPort = z.number().int().min(1).max(65535);

export const zRemoteConfig = z.object({
  enabled: z.boolean(),
  serverAddr: z.string(),
  serverPort: zPort.default(7000),
  frpToken: z.string(),
  remotePort: zPort.default(18080),
  publicPort: zPort.default(443),
  publicUrl: z.string(),
  desktopName: z.string(),
  frpcPath: z.string(),
  trustedCaFile: z.string().default("")
});

export const zRemoteStatus = z.object({
  state: z.enum(["disabled", "connecting", "connected", "error"]),
  error: z.string().optional(),
  gatewayPort: zPort.optional(),
  connectedDevices: z.number().int().nonnegative(),
  frpcPath: z.string().optional()
});

export const zRemotePair = z.object({
  code: z.string(),
  qrContent: z.string(),
  expiresAt: z.string()
});

export const zRemoteDevice = z.object({
  deviceId: z.string().min(1),
  name: z.string(),
  pairedAt: z.string(),
  lastConnectedAt: z.string().optional(),
  pushAvailable: z.boolean()
});

export type RemoteConfig = z.infer<typeof zRemoteConfig>;
export type RemoteStatus = z.infer<typeof zRemoteStatus>;
export type RemotePair = z.infer<typeof zRemotePair>;
export type RemoteDevice = z.infer<typeof zRemoteDevice>;
