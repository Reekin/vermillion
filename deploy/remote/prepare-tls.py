#!/usr/bin/env python3
"""Create an FRP transport CA and a server certificate in private staging."""
import argparse
import ipaddress
import os
from pathlib import Path
import shutil
import subprocess


def run(*args):
    result = subprocess.run(["openssl", *args], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(result.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--existing-dir", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    args.output_dir.mkdir(mode=0o700)
    root = args.output_dir
    ca, key = str(root / "ca.crt"), str(root / "ca.key")
    if args.existing_dir and args.existing_dir.exists():
        # Losing either CA file is an error; never silently rotate client trust.
        for name in ("ca.crt", "ca.key"):
            shutil.copyfile(args.existing_dir / name, root / name)
        run("x509", "-in", ca, "-checkend", "2592000", "-noout")
    else:
        run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-days", "3650", "-subj", "/CN=Vermillion FRP transport CA",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", key, "-out", ca)
    try:
        ipaddress.ip_address(args.host)
        san, verify = f"IP:{args.host}", "-verify_ip"
    except ValueError:
        san, verify = f"DNS:{args.host}", "-verify_hostname"
    ext = root / "server.ext"
    ext.write_text(f"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName={san}\n")
    run("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
        "-subj", "/CN=Vermillion FRP server", "-keyout", str(root / "server.key"), "-out", str(root / "server.csr"))
    run("x509", "-req", "-in", str(root / "server.csr"), "-CA", ca, "-CAkey", key,
        "-set_serial", "0x" + os.urandom(16).hex(), "-days", "825", "-extfile", str(ext), "-out", str(root / "server.crt"))
    run("verify", "-CAfile", ca, verify, args.host, str(root / "server.crt"))
    print("FRP transport certificate verified against its CA and VPS identity.")


if __name__ == "__main__":
    main()
