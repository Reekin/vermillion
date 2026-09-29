import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import QRCode from "qrcode";
import type { RemoteConfig, RemoteDevice, RemotePair, RemoteStatus } from "@vermillion/workbench/client";
import { createRendererWorkbenchClient } from "../workbench-client.js";
import { Modal } from "./Modal.js";
import { Badge, Button, Field, IconButton, InlineNotice, ListRow, PanelHeader, Toggle } from "./ui.js";
import { intlLocale, serviceText, t } from "../../../i18n/index.js";
import { useT } from "../../../i18n/react.js";

const stateLabel = (state: RemoteStatus["state"]) => t(`remote.state.${state}`);
const formatTime = (value?: string) => value ? new Date(value).toLocaleString(intlLocale()) : t("remote.neverConnected");

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
  const t = useT();
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
  const [testingPush, setTestingPush] = useState<string>();
  const [pushResult, setPushResult] = useState<string>();
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
    }).catch(() => { if (!disposed) setError(t("remote.qrFailed")); });
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
      setError(t("remote.portInvalid"));
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

  const testPush = async (deviceId: string) => {
    setTestingPush(deviceId); setPushResult(undefined);
    try {
      await client.request("remote.push.test", { deviceId });
      setPushResult(t("remote.pushAccepted"));
    } catch (cause) { setPushResult(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTestingPush(undefined); }
  };

  const pickPushKey = async () => {
    try {
      const picked = await window.sessionDesktop?.pickRemoteProgramPath("apns");
      if (picked?.path && !picked.canceled) save({ apnsKeyPath: picked.path });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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

  return <section ref={section} className="flex max-w-2xl flex-col gap-3 border-t border-border pt-2" aria-label={t("remote.title")}>
    <PanelHeader title={t("remote.title")} className="-ml-4" align="start">
      {status && <Badge>{stateLabel(status.state)}</Badge>}
    </PanelHeader>
    {(error || refreshError) && <InlineNotice tone="error" className="px-0 pb-0">{error || refreshError}</InlineNotice>}
    {status?.error && <InlineNotice tone="error" className="px-0 pb-0">{serviceText(status.error)}</InlineNotice>}
    {!config && !refreshError && <InlineNotice className="px-0 pb-0">{t("remote.loading")}</InlineNotice>}
    {config && <>
      <Toggle label={t("remote.enable")} checked={config.enabled} disabled={saving} onChange={(enabled) => save({ enabled })} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ConfigField label={t("remote.serverAddr")} value={config.serverAddr} onSave={(serverAddr) => save({ serverAddr: serverAddr.trim() })} />
        <ConfigField label={t("remote.serverPort")} type="number" value={config.serverPort} onSave={(value) => savePort("serverPort", value)} />
        <ConfigField label={t("remote.frpToken")} type="password" value={config.frpToken} onSave={(frpToken) => save({ frpToken })} />
        <ConfigField label={t("remote.remotePort")} type="number" value={config.remotePort} onSave={(value) => savePort("remotePort", value)} />
        <ConfigField label={t("remote.publicPort")} type="number" value={config.publicPort} onSave={(value) => savePort("publicPort", value)} />
        <ConfigField label={t("remote.publicUrl")} value={config.publicUrl} placeholder={defaultPublicUrl} onSave={(publicUrl) => save({ publicUrl: publicUrl.trim() })} />
        <ConfigField label={t("remote.desktopName")} value={config.desktopName} onSave={(desktopName) => save({ desktopName: desktopName.trim() })} />
      </div>
      <ConfigField label={t("remote.trustedCa")} value={config.trustedCaFile} onSave={(trustedCaFile) => save({ trustedCaFile: trustedCaFile.trim() })} />
      <div className="flex flex-col gap-2">
        <span className="eyebrow">{t("remote.frpcPath")}</span>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-body text-foreground" title={status?.frpcPath || config.frpcPath || t("remote.frpcFromPath")}>
            {status?.frpcPath || config.frpcPath || t("remote.frpcFromPath")}
          </span>
          <Button variant="ghost" size="sm" outlined disabled={saving} onClick={() => void pickProgram()}>{t("app.settingsPage.choose")}</Button>
          {config.frpcPath && <Button variant="ghost" size="sm" outlined disabled={saving} onClick={() => save({ frpcPath: "" })}>{t("app.settingsPage.restoreDefault")}</Button>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={!config.enabled || status?.state !== "connected" || pairing || saving} onClick={() => void beginPair()}>
          {pairing ? t("remote.generating") : t("remote.pairDevice")}
        </Button>
        {status && <span className="text-caption text-muted-foreground">{t("remote.connectedDevices", { count: status.connectedDevices })}</span>}
      </div>
      {pairedName && !pair && <InlineNotice className="px-0 pb-0">{t("remote.paired", { name: pairedName })}</InlineNotice>}
      <PanelHeader title={t("remote.push")} className="-ml-4" align="start"><Badge>{status?.pushConfigured ? t("remote.pushConfigured") : t("remote.pushNotConfigured")}</Badge></PanelHeader>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1"><ConfigField label={t("remote.apnsKey")} value={config.apnsKeyPath} onSave={(apnsKeyPath) => save({ apnsKeyPath: apnsKeyPath.trim() })} /></div>
        <Button variant="ghost" size="sm" outlined disabled={saving} onClick={() => void pickPushKey()}>{t("remote.chooseKey")}</Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ConfigField label="Key ID" value={config.apnsKeyId} onSave={(apnsKeyId) => save({ apnsKeyId: apnsKeyId.trim() })} />
        <ConfigField label="Team ID" value={config.apnsTeamId} onSave={(apnsTeamId) => save({ apnsTeamId: apnsTeamId.trim() })} />
        <ConfigField label="App Bundle ID" value={config.apnsBundleId} onSave={(apnsBundleId) => save({ apnsBundleId: apnsBundleId.trim() })} />
      </div>
      <InlineNotice className="min-h-8 px-0 pb-0">{pushResult || serviceText(status?.pushError) || t("remote.pushHint")}</InlineNotice>
      <PanelHeader title={t("remote.devices")} className="-ml-4" />
      {devices.length === 0 && <InlineNotice className="px-0 pb-0">{t("remote.noDevices")}</InlineNotice>}
      {devices.map((device) => <ListRow key={device.deviceId} title={device.name}
        meta={<><span className="block">{t("remote.pairedAt", { time: formatTime(device.pairedAt) })}</span><span className="block">{t("remote.lastConnected", { time: formatTime(device.lastConnectedAt) })}</span></>}
        trailing={<div className="flex items-center gap-2"><Badge>{device.pushAvailable ? t("remote.pushAvailable") : t("remote.pushUnavailable")}</Badge>
          <Button variant="ghost" size="sm" outlined disabled={!device.pushAvailable || !status?.pushConfigured || !config.enabled || Boolean(testingPush) || saving}
            onClick={() => void testPush(device.deviceId)}>{testingPush === device.deviceId ? t("remote.sendingPush") : t("remote.testPush")}</Button></div>}
        hoverActions={<IconButton icon={X} label={t("remote.removeDeviceLabel", { name: device.name })} onClick={() => setRemoveDevice(device)} />} />)}
    </>}
    {pair && <Modal title={t("remote.pairDevice")} width={360} onClose={() => setPair(undefined)}>
      <div className="flex flex-col items-center gap-3 p-5">
        {pairedName ? <InlineNotice>{t("remote.paired", { name: pairedName })}</InlineNotice> : expired ? <>
          <InlineNotice>{t("remote.codeExpired")}</InlineNotice><Button disabled={pairing} onClick={() => void beginPair()}>{t("remote.regenerate")}</Button>
        </> : <>
          {qrImage && <img src={qrImage} alt={t("remote.qrAlt")} width={240} height={240} />}
          <span className="font-mono text-title text-strong">{pair.code}</span>
          <span className="break-all text-caption text-muted-foreground">{publicUrl}</span>
          <InlineNotice>{t("remote.codeRemaining", { minutes: remainingMinutes })}</InlineNotice>
        </>}
      </div>
    </Modal>}
    {removeDevice && <Modal title={t("remote.removeDevice")} width={360} onClose={() => { if (!removing) setRemoveDevice(undefined); }}>
      <div className="flex flex-col gap-3 p-5">
        <p className="text-body text-foreground">{t("remote.removeDeviceConfirm", { name: removeDevice.name })}</p>
        <div className="flex gap-2"><Button disabled={removing} onClick={() => void revoke()}>{t("remote.remove")}</Button><Button variant="ghost" disabled={removing} onClick={() => setRemoveDevice(undefined)}>{t("common.cancel")}</Button></div>
      </div>
    </Modal>}
  </section>;
}
