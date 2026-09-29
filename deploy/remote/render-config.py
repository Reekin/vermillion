#!/usr/bin/env python3
"""Render private VPS configuration; no services or network operations."""
import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import stat


def port(value):
    if not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise argparse.ArgumentTypeError("port must be 1..65535")
    return int(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="public IPv4, IPv6 or DNS name (no scheme/port)")
    parser.add_argument("--map", action="append", required=True, metavar="HTTPS:LOOPBACK")
    parser.add_argument("--frp-port", type=port, default=7000)
    parser.add_argument("--token-file", type=Path, help="private UTF-8 file; otherwise hidden terminal prompt")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--tls-dir", type=Path, default=Path("/etc/vermillion-remote/tls"))
    args = parser.parse_args()
    host = args.host
    sni_default = None
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            parser.error("--host must be a public IP address")
        host = f"[{ip}]" if ip.version == 6 else str(ip)
        sni_default = str(ip)
    except ValueError:
        if len(host) > 253 or "." not in host or not all(
            re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
            for label in host.split(".")
        ):
            parser.error("invalid public IP or DNS name")
    mappings = []
    used = {80, args.frp_port}
    if args.frp_port in (80, 443) or args.frp_port < 1024:
        parser.error("frp transport port must be >=1024 and separate from 80/443")
    for mapping in args.map:
        parts = mapping.split(":")
        try:
            public, backend = map(port, parts)
        except (ValueError, argparse.ArgumentTypeError):
            parser.error("--map must be HTTPS:LOOPBACK, both valid ports")
        if public in used or backend in used or public == backend or backend < 1024 or backend == 443:
            parser.error("all ports must be distinct; backend >=1024; port 80 reserved for ACME")
        if public < 1024 and public != 443:
            parser.error("public port must be 443 or >=1024")
        used.update((public, backend))
        mappings.append((public, backend))
    if args.token_file:
        info = args.token_file.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            parser.error("token file must be a regular file with mode 600 or 400")
        token = args.token_file.read_text(encoding="utf-8").rstrip("\r\n")
    else:
        if not os.isatty(0):
            parser.error("use --token-file for noninteractive operation")
        token = getpass.getpass("frp token (at least 32 characters): ")
    if len(token) < 32 or any(ord(c) < 32 for c in token):
        parser.error("token must contain at least 32 characters and no control characters")
    os.umask(0o077)
    args.output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.output_dir.stat().st_mode & 0o077:
        parser.error("output directory must have mode 700")
    frps = [
        'bindAddr = "::"', f"bindPort = {args.frp_port}",
        'proxyBindAddr = "127.0.0.1"', 'auth.method = "token"',
        f"auth.token = {json.dumps(token, ensure_ascii=False)}",
        'transport.tls.force = true', 'log.level = "warn"',
        f"transport.tls.certFile = {json.dumps(str(args.tls_dir / 'server.crt'))}",
        f"transport.tls.keyFile = {json.dumps(str(args.tls_dir / 'server.key'))}",
        "allowPorts = [" + ", ".join(f"{{ single = {b} }}" for _, b in mappings) + "]",
    ]
    # Explicit ACME prevents Caddy's local-IP certificate defaults. HTTP-01 uses
    # port 80 even when each desktop's HTTPS endpoint uses a different port.
    caddy = ["{", "\tadmin off", "\tauto_https disable_redirects"]
    # Clients send no SNI for IP addresses; on NAT cloud hosts the local address is
    # private, so Caddy needs the public IP to select the issued certificate.
    if sni_default:
        caddy.append(f"\tdefault_sni {sni_default}")
    caddy.append("}")
    for public, backend in mappings:
        caddy += [f"https://{host}:{public} {{", "\ttls {",
                  "\t\tissuer acme {", "\t\t\tdir https://acme-v02.api.letsencrypt.org/directory",
                  "\t\t\tprofile shortlived", "\t\t\tdisable_tlsalpn_challenge", "\t\t}", "\t}",
                  f"\treverse_proxy 127.0.0.1:{backend}", "}"]
    for name, content in (("frps.toml", "\n".join(frps)), ("Caddyfile", "\n".join(caddy))):
        target = args.output_dir / name
        # O_NOFOLLOW prevents replacing an unrelated target through a symlink.
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(content + "\n")
    print("Rendered HTTPS → loopback routes:")
    for public, backend in mappings:
        print(f"  https://{host}:{public} → 127.0.0.1:{backend}")
    print(f"Allow inbound TCP: 80, {args.frp_port}, " + ", ".join(str(p) for p, _ in mappings))
    print("Never open the loopback backend ports in the VPS firewall.")


if __name__ == "__main__":
    main()
