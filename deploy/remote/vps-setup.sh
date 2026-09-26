#!/usr/bin/env bash
# Debian/Ubuntu systemd installer. --validate-only also works on macOS.
set -euo pipefail
umask 077
CADDY_VERSION=2.11.4
FRP_VERSION=0.71.0
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
VALIDATE_ONLY=false
PUBLIC_HOST=
ARGS=()
while (($#)); do
  case "$1" in
    --validate-only) VALIDATE_ONLY=true; shift ;;
    --help|-h)
      printf '%s\n' 'Usage: bash vps-setup.sh [--validate-only] --host IP_OR_DOMAIN --map HTTPS:LOOPBACK [--map ...] [--frp-port 7000] [--token-file PRIVATE_FILE]' 'Requires python3, curl, tar, OpenSSL 1.1.1+; installation additionally requires root on Debian/Ubuntu with systemd.' 'Token is read from a mode-600 file or hidden terminal prompt; never pass it in arguments.'
      exit 0 ;;
    --host|--map|--frp-port|--token-file)
      (($# >= 2)) || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
      [[ $1 != --host ]] || PUBLIC_HOST=$2
      ARGS+=("$1" "$2"); shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
for tool in python3 curl tar openssl; do command -v "$tool" >/dev/null || { printf 'Install prerequisite: %s\n' "$tool" >&2; exit 1; }; done
if ! "$VALIDATE_ONLY"; then
  [[ $(uname -s) == Linux && $EUID == 0 ]] || { printf '%s\n' 'Installation requires root on a Debian/Ubuntu VPS. Use --validate-only locally.' >&2; exit 1; }
  source /etc/os-release
  [[ $ID == debian || $ID == ubuntu ]] || { printf '%s\n' 'Supported OS: Debian or Ubuntu.' >&2; exit 1; }
  [[ -d /run/systemd/system ]] || { printf '%s\n' 'systemd must be running.' >&2; exit 1; }
fi
TASK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/vermillion-vps.XXXXXX")
trap 'rm -rf -- "$TASK_TMP"' EXIT
python3 "$SCRIPT_DIR/render-config.py" "${ARGS[@]}" --output-dir "$TASK_TMP/config" --tls-dir "$TASK_TMP/tls"
if "$VALIDATE_ONLY"; then
  python3 "$SCRIPT_DIR/prepare-tls.py" --host "$PUBLIC_HOST" --output-dir "$TASK_TMP/tls"
else
  python3 "$SCRIPT_DIR/prepare-tls.py" --host "$PUBLIC_HOST" --output-dir "$TASK_TMP/tls" --existing-dir /etc/vermillion-remote/tls
fi
case $(uname -m) in x86_64) ARCH=amd64 ;; arm64|aarch64) ARCH=arm64 ;; *) printf '%s\n' 'Supported CPU: amd64 or arm64.' >&2; exit 1 ;; esac
case $(uname -s) in Linux) FRP_OS=linux; CADDY_OS=linux ;; Darwin) FRP_OS=darwin; CADDY_OS=mac ;; *) exit 1 ;; esac
download() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 180 --proto '=https' --tlsv1.2 "$1" --output "$2"; }
FRP_ARCHIVE="frp_${FRP_VERSION}_${FRP_OS}_${ARCH}.tar.gz"
CADDY_ARCHIVE="caddy_${CADDY_VERSION}_${CADDY_OS}_${ARCH}.tar.gz"
download "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/$FRP_ARCHIVE" "$TASK_TMP/$FRP_ARCHIVE"
download "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/frp_sha256_checksums.txt" "$TASK_TMP/frp-checksums"
download "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$CADDY_ARCHIVE" "$TASK_TMP/$CADDY_ARCHIVE"
download "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_checksums.txt" "$TASK_TMP/caddy-checksums"
python3 - "$TASK_TMP" "$FRP_ARCHIVE" "$CADDY_ARCHIVE" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
for archive, sums in zip(sys.argv[2:], ("frp-checksums", "caddy-checksums")):
    entries = [line.split() for line in (root / sums).read_text().splitlines() if line.strip()]
    expected = next((a for a, b in entries if b.lstrip("*") == archive), None)
    algorithm = hashlib.sha256 if sums == "frp-checksums" else hashlib.sha512
    actual = algorithm((root / archive).read_bytes()).hexdigest()
    if expected != actual:
        raise SystemExit(f"Checksum mismatch: {archive}")
    print(f"{algorithm().name.upper()} verified: {archive}")
PY
tar -xzf "$TASK_TMP/$FRP_ARCHIVE" -C "$TASK_TMP"
tar -xzf "$TASK_TMP/$CADDY_ARCHIVE" -C "$TASK_TMP" caddy
FRPS="$TASK_TMP/frp_${FRP_VERSION}_${FRP_OS}_${ARCH}/frps"
"$FRPS" --version
"$TASK_TMP/caddy" version
"$FRPS" verify -c "$TASK_TMP/config/frps.toml"
# Provisioning validation is isolated from the user's Caddy data/config.
XDG_DATA_HOME="$TASK_TMP/data" XDG_CONFIG_HOME="$TASK_TMP/xdg" "$TASK_TMP/caddy" validate --config "$TASK_TMP/config/Caddyfile" --adapter caddyfile
if "$VALIDATE_ONLY"; then
  printf '%s\n' 'Validation passed. No services, firewall or system configuration changed.'
  exit 0
fi
# Do not take over an existing Caddy or FRP installation.
for SERVICE in caddy frps; do
  if systemctl is-active --quiet "$SERVICE"; then
    printf 'Existing %s service is active. Use a dedicated VPS or resolve the port ownership first.\n' "$SERVICE" >&2
    exit 1
  fi
done
PREFIX=/opt/vermillion-remote
CONFIG=/etc/vermillion-remote
if [[ -e $PREFIX && ! -f $PREFIX/managed-by-vps-setup ]]; then
  printf '%s\n' 'Unmanaged /opt/vermillion-remote exists; refusing to overwrite.' >&2
  exit 1
fi
for USER_NAME in vermillion-frps vermillion-caddy; do
  if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_NAME"
  fi
done
install -d -m 755 "$PREFIX" "$CONFIG"
install -d -m 750 -o root -g vermillion-frps "$CONFIG/tls"
install -m 600 -o root -g root "$TASK_TMP/tls/ca.key" "$CONFIG/tls/ca.key"
install -m 644 -o root -g root "$TASK_TMP/tls/ca.crt" "$CONFIG/frp-ca.crt"
install -m 640 -o root -g vermillion-frps "$TASK_TMP/tls/ca.crt" "$CONFIG/tls/ca.crt"
install -m 640 -o root -g vermillion-frps "$TASK_TMP/tls/server.crt" "$CONFIG/tls/server.crt"
install -m 640 -o root -g vermillion-frps "$TASK_TMP/tls/server.key" "$CONFIG/tls/server.key"
python3 - "$TASK_TMP/config/frps.toml" "$TASK_TMP/tls" "$CONFIG/tls" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
for name in ("server.crt", "server.key"):
    text = text.replace(json.dumps(str(pathlib.Path(sys.argv[2]) / name)), json.dumps(str(pathlib.Path(sys.argv[3]) / name)))
path.write_text(text)
PY
install -d -m 700 -o vermillion-caddy -g vermillion-caddy /var/lib/vermillion-caddy
for BINARY in frps caddy; do
  SOURCE="$TASK_TMP/caddy"
  [[ $BINARY != frps ]] || SOURCE="$FRPS"
  install -m 755 "$SOURCE" "$PREFIX/$BINARY.new"
  mv -f "$PREFIX/$BINARY.new" "$PREFIX/$BINARY"
done
install -m 640 -o root -g vermillion-frps "$TASK_TMP/config/frps.toml" "$CONFIG/frps.toml.new"
install -m 640 -o root -g vermillion-caddy "$TASK_TMP/config/Caddyfile" "$CONFIG/Caddyfile.new"
mv -f "$CONFIG/frps.toml.new" "$CONFIG/frps.toml"
mv -f "$CONFIG/Caddyfile.new" "$CONFIG/Caddyfile"
install -m 644 "$SCRIPT_DIR/vermillion-frps.service" /etc/systemd/system/vermillion-frps.service
install -m 644 "$SCRIPT_DIR/vermillion-caddy.service" /etc/systemd/system/vermillion-caddy.service
touch "$PREFIX/managed-by-vps-setup"
systemctl daemon-reload
systemctl enable vermillion-frps vermillion-caddy
systemctl restart vermillion-frps vermillion-caddy
systemctl is-active --quiet vermillion-frps vermillion-caddy
printf '%s\n' 'Installed. Configure VPS/cloud firewall as listed above. Certificate issuance needs public TCP 80.' 'Check: journalctl -u vermillion-caddy -u vermillion-frps --since "5 minutes ago"' 'The service being active does not prove that the public certificate has been issued; verify HTTPS from another machine.'
printf '%s\n' 'Copy /etc/vermillion-remote/frp-ca.crt to each desktop over trusted SSH and set its FRP trusted CA path.' 'Re-run this installer before the FRP server certificate expires (825 days); the existing CA is retained.'
