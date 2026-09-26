import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import QRCode from "qrcode";
import type { RemoteConfig, RemoteDevice, RemotePair, RemoteStatus } from "@vermillion/workbench/client";
import { createRendererWorkbenchClient } from "../workbench-client.js";
import { Modal } from "./Modal.js";
import { Badge, Button, Field, IconButton, InlineNotice, ListRow, PanelHeader, Toggle } from "./ui.js";

const stateLabels: Record<RemoteStatus["state"], string> = {
  disabled: "已关闭", connecting: "连接中", connected: "隧道已连接", error: "连接失败"
};
const formatTime = (value?: string) => value ? new Date(value).toLocaleString() : "尚未连接";

function ConfigField({ label, value, type = "text", placeholder, onSave }: {
  label: string; value: string | number; type?: "text" | "password" | "number";
  placeholder?: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  return <Field label={label} type={type} value={draft} placeholder={placeholder} autoComplete="off"
    min={type === "number" ? 1 : undefined} max={type === "number" ? 65535 : undefined}
    onFocus={() => { focused.current = true; }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { focused.current = false; if (draft !== String(value)) onSave(draft); }} />;
}

export function RemoteAccessSettings() {
  const client = useMemo(createRendererWorkbenchClient, []);
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<RemoteConfig>();
  const [status, setStatus] = useState<RemoteStatus>();
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [error, setError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [pair, setPair] = useState<RemotePair>();
  const [qrImage, setQrImage] = useState<string>();
  const [pairing, setPairing] = useState(false);
  const [pairedName, setPairedName] = useState<string>();
  const [expired, setExpired] = useState(false);
  const [remainingMinutes, setRemainingMinutes] = useState(10);
  const [removeDevice, setRemoveDevice] = useState<RemoteDevice>();
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const loaded = useRef(false);
  const pairDeviceIds = useRef(new Set<string>());
  const serverHost = config?.serverAddr.includes(":") && !config.serverAddr.startsWith("[")
    ? `[${config.serverAddr}]` : config?.serverAddr;
  const defaultPublicUrl = serverHost ? `https://${serverHost}:${config?.publicPort}` : "";
  const publicUrl = config?.publicUrl || defaultPublicUrl;

  // Settings remains mounted while its modal is hidden. Only visible settings request updates.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)));
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      loaded.current = false;
      setPair(undefined);
      setRemoveDevice(undefined);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const [nextStatus, nextDevices, initialConfig] = await Promise.all([
          client.request("remote.status", {}),
          client.request("remote.device.list", {}),
          loaded.current ? undefined : client.request("remote.configure", {})
        ]);
        if (disposed) return;
        setStatus(nextStatus);
        setDevices(nextDevices);
        if (initialConfig) { setConfig(initialConfig); loaded.current = true; }
        setRefreshError(undefined);
      } catch (cause) {
        if (!disposed) setRefreshError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 3000);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, visible]);

  useEffect(() => {
    if (!pair) return;
    const matched = devices.find((device) => !pairDeviceIds.current.has(device.deviceId));
    if (matched) setPairedName(matched.name);
  }, [devices, pair]);

  useEffect(() => {
    if (!pairedName || !pair) return;
    const timer = setTimeout(() => setPair(undefined), 1500);
    return () => clearTimeout(timer);
  }, [pairedName, pair]);

  useEffect(() => {
    setQrImage(undefined);
    setExpired(false);
    if (!pair) return;
    let disposed = false;
    const updateRemaining = () => setRemainingMinutes(Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - Date.now()) / 60_000)));
    updateRemaining();
    const countdown = setInterval(updateRemaining, 1000);
    void QRCode.toDataURL(pair.qrContent, { width: 240, margin: 2 }).then((url) => {
      if (!disposed) setQrImage(url);
    }).catch(() => { if (!disposed) setError("二维码生成失败，请使用公网地址和配对码配对。"); });
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(pair.expiresAt) - Date.now()));
    return () => { disposed = true; clearTimeout(timer); clearInterval(countdown); };
  }, [pair]);

  const save = useCallback((patch: Partial<RemoteConfig>) => {
    setSaving(true);
    const pending = saveQueue.current.then(async () => {
      setError(undefined);
      try {
        setConfig(await client.request("remote.configure", { patch }));
        setStatus(await client.request("remote.status", {}));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    saveQueue.current = pending;
    void pending.finally(() => { if (saveQueue.current === pending) setSaving(false); });
  }, [client]);

  const savePort = (key: "serverPort" | "remotePort" | "publicPort", value: string) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("端口须为 1 到 65535 之间的整数。");
      return;
    }
    save({ [key]: port });
  };

  const pickProgram = async () => {
    try {
      const picked = await window.sessionDesktop?.pickRemoteProgramPath();
      if (picked?.path && !picked.canceled) save({ frpcPath: picked.path });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const beginPair = async () => {
    setPairing(true);
    setError(undefined);
    setPairedName(undefined);
    try {
      const currentDevices = await client.request("remote.device.list", {});
      pairDeviceIds.current = new Set(currentDevices.map((device) => device.deviceId));
      setDevices(currentDevices);
      setPair(await client.request("remote.pair", {}));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPairing(false); }
  };

  const revoke = async () => {
    if (!removeDevice) return;
    setRemoving(true);
    setError(undefined);
    try {
      await client.request("remote.device.revoke", { deviceId: removeDevice.deviceId });
      setDevices((current) => current.filter((device) => device.deviceId !== removeDevice.deviceId));
      setRemoveDevice(undefined);
      setStatus(await client.request("remote.status", {}));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRemoving(false); }
  };

  return <section ref={section} className="flex max-w-2xl flex-col gap-3 border-t border-border pt-2" aria-label="远程访问">
    <PanelHeader title="远程访问" className="-ml-4" align="start">
      {status && <Badge>{stateLabels[status.state]}</Badge>}
    </PanelHeader>
    {(error || refreshError) && <InlineNotice tone="error" className="px-0 pb-0">{error || refreshError}</InlineNotice>}
    {status?.error && <InlineNotice tone="error" className="px-0 pb-0">{status.error}</InlineNotice>}
    {!config && !refreshError && <InlineNotice className="px-0 pb-0">正在读取远程访问设置…</InlineNotice>}
    {config && <>
      <Toggle label="开启远程访问" checked={config.enabled} disabled={saving} onChange={(enabled) => save({ enabled })} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ConfigField label="VPS 地址" value={config.serverAddr} onSave={(serverAddr) => save({ serverAddr: serverAddr.trim() })} />
        <ConfigField label="frp 服务端口" type="number" value={config.serverPort} onSave={(value) => savePort("serverPort", value)} />
        <ConfigField label="frp token" type="password" value={config.frpToken} onSave={(frpToken) => save({ frpToken })} />
        <ConfigField label="桌面在 VPS 上的端口" type="number" value={config.remotePort} onSave={(value) => savePort("remotePort", value)} />
        <ConfigField label="公网 HTTPS 端口" type="number" value={config.publicPort} onSave={(value) => savePort("publicPort", value)} />
        <ConfigField label="公网地址" value={config.publicUrl} placeholder={defaultPublicUrl} onSave={(publicUrl) => save({ publicUrl: publicUrl.trim() })} />
        <ConfigField label="桌面名称" value={config.desktopName} onSave={(desktopName) => save({ desktopName: desktopName.trim() })} />
      </div>
      <ConfigField label="frp 服务端 CA 证书路径" value={config.trustedCaFile} onSave={(trustedCaFile) => save({ trustedCaFile: trustedCaFile.trim() })} />
      <div className="flex flex-col gap-2">
        <span className="eyebrow">frpc 程序路径</span>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-body text-foreground" title={status?.frpcPath || config.frpcPath || "frpc（PATH）"}>
            {status?.frpcPath || config.frpcPath || "frpc（PATH）"}
          </span>
          <Button variant="ghost" size="sm" outlined disabled={saving} onClick={() => void pickProgram()}>选择</Button>
          {config.frpcPath && <Button variant="ghost" size="sm" outlined disabled={saving} onClick={() => save({ frpcPath: "" })}>恢复默认</Button>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={!config.enabled || status?.state !== "connected" || pairing || saving} onClick={() => void beginPair()}>
          {pairing ? "正在生成…" : "配对新设备"}
        </Button>
        {status && <span className="text-caption text-muted-foreground">{status.connectedDevices} 台设备已连接</span>}
      </div>
      {pairedName && !pair && <InlineNotice className="px-0 pb-0">{`${pairedName} 已配对`}</InlineNotice>}
      <PanelHeader title="已配对设备" className="-ml-4" />
      {devices.length === 0 && <InlineNotice className="px-0 pb-0">尚无已配对设备</InlineNotice>}
      {devices.map((device) => <ListRow key={device.deviceId} title={device.name}
        meta={<><span className="block">{`配对：${formatTime(device.pairedAt)}`}</span><span className="block">{`最近连接：${formatTime(device.lastConnectedAt)}`}</span></>}
        trailing={<Badge>{device.pushAvailable ? "推送可用" : "推送不可用"}</Badge>}
        hoverActions={<IconButton icon={X} label={`移除 ${device.name}`} onClick={() => setRemoveDevice(device)} />} />)}
    </>}
    {pair && <Modal title="配对新设备" width={360} onClose={() => setPair(undefined)}>
      <div className="flex flex-col items-center gap-3 p-5">
        {pairedName ? <InlineNotice>{`${pairedName} 已配对`}</InlineNotice> : expired ? <>
          <InlineNotice>配对码已过期</InlineNotice><Button disabled={pairing} onClick={() => void beginPair()}>重新生成</Button>
        </> : <>
          {qrImage && <img src={qrImage} alt="远程访问配对二维码" width={240} height={240} />}
          <span className="font-mono text-title text-strong">{pair.code}</span>
          <span className="break-all text-caption text-muted-foreground">{publicUrl}</span>
          <InlineNotice>{`剩余约 ${remainingMinutes} 分钟，仅可使用一次`}</InlineNotice>
        </>}
      </div>
    </Modal>}
    {removeDevice && <Modal title="移除设备" width={360} onClose={() => { if (!removing) setRemoveDevice(undefined); }}>
      <div className="flex flex-col gap-3 p-5">
        <p className="text-body text-foreground">{`移除 ${removeDevice.name} 后，该设备会立即断开，再次连接需要重新配对。`}</p>
        <div className="flex gap-2"><Button disabled={removing} onClick={() => void revoke()}>移除</Button><Button variant="ghost" disabled={removing} onClick={() => setRemoveDevice(undefined)}>取消</Button></div>
      </div>
    </Modal>}
  </section>;
}
