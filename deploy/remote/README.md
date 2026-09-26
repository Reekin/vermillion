# 手机远程网关部署

在有公网 IP 的 Debian 12+/Ubuntu 22.04+ VPS 上运行安装脚本。每台桌面占用一个公网 HTTPS 端口与一个独立的 VPS 回环端口：

```text
iPhone → https://VPS:8443 → Caddy → 127.0.0.1:18001 → frps ⇄ TLS ⇄ Mac frpc → 桌面回环网关
iPhone → https://VPS:8444 → Caddy → 127.0.0.1:18002 → frps ⇄ TLS ⇄ PC frpc  → 桌面回环网关
                                               frps 公网传输端口：7000
```

`8443/8444` 只由 Caddy 监听。frps 的 `proxyBindAddr = "127.0.0.1"` 保证转发的明文 HTTP 不会监听公网；`allowPorts` 限制客户端只能申请配置里的回环端口。两个数字不能相同。frps 的传输监听支持双栈，要求 VPS 未禁用 IPv6 socket（只有 IPv4 公网地址也可使用）。不启用 frp dashboard、HTTP vhost 或 UDP transport。

## VPS 安装

将本目录上传到 VPS。预装依赖：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl python3 tar openssl
bash vps-setup.sh --help
sudo bash vps-setup.sh --host YOUR_PUBLIC_IP --map 8443:18001 --map 8444:18002
```

`--host` 接受公网 IPv4、无方括号的 IPv6 或域名，不含协议或端口。域名的 A/AAAA 应全部指向此 VPS。可重复 `--map HTTPS:LOOPBACK`；`--frp-port` 默认 7000。安装时隐藏输入至少 32 字符的随机 token，同一个 token 配置到各桌面。可用密码管理器生成并保存；不要把 token 放进命令参数、聊天或日志。无人值守执行用 `--token-file /root/frp-token`，文件必须是 UTF-8 单行、权限 600/400。脚本不会输出 token。

Windows 可双击 `vps-setup.bat`，按提示输入 SSH 地址、公网地址和映射；它通过系统 OpenSSH 上传脚本并进入 VPS 安装终端，sudo 密码和 token 在终端内输入。需要 Windows OpenSSH Client、可交互登录和 sudo 权限。非默认 SSH 端口/IPv6 SSH 地址使用 `%USERPROFILE%\.ssh\config` 的 Host 别名。包装脚本不接受 token 参数，不在 Windows 保存 token。

脚本固定下载 **Caddy 2.11.4 / frp 0.71.0** 官方 release，核对官方校验清单（Caddy SHA512、frp SHA256），生成私有临时配置，实际执行 `frps verify` 与 `caddy validate`。全部成功后才安装自有 systemd 服务。下载失败或配置验证失败不会改服务。支持 amd64/arm64。重复执行会更新同一组配置和二进制并重启服务，不重复创建用户，也不删除证书数据。更新时会短暂断线；客户端恢复连接。若已有活动的 `caddy`/`frps` 服务，脚本拒绝接管，宜使用独立 VPS。

安装使用 `/opt/vermillion-remote/`、`/etc/vermillion-remote/`，以及 `vermillion-frps`、`vermillion-caddy` 两个专用系统用户与 systemd 服务。frps 配置是 root 与 frps 用户组可读的 640 文件，包含 token。Caddy 证书和 ACME 账户放在 `/var/lib/vermillion-caddy/`，目录 700，重复安装保留。不要把这些私有文件纳入公开备份。脚本不调整任何防火墙规则。

frp 传输使用独立的私有 CA，CA 私钥仅 root 可读；安装器为 `--host` 签发服务端证书，重复运行保留同一 CA、更新服务端证书。传输证书有效期 825 天，过期前重跑安装器；它与自动续期的公网 HTTPS 证书独立。CA 有效期 10 年，到期换 CA 时需要同步更新所有桌面的信任文件。备份 VPS 时安全保管 `/etc/vermillion-remote/tls/ca.key` 和 `ca.crt`；遗失 CA 文件时安装器报错，不静默更换桌面信任。

只检查配置、下载和工具兼容性，不安装服务（也可在 macOS 上运行）：

```sh
bash vps-setup.sh --validate-only --host YOUR_PUBLIC_IP --map 8443:18001
```

## 无域名 HTTPS 与防火墙

IP 证书使用 Let’s Encrypt 的 `shortlived` profile，证书有效期约 6 天，由 Caddy 自动续期。配置显式指定 ACME issuer，不能把 IP 地址站点交给隐式本地 CA，也不要使用 `tls internal` 部署公网服务。官方依据：

- [Let’s Encrypt：IP 与 6 天证书已正式开放](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Caddy：ACME issuer 的 profile 参数](https://caddyserver.com/docs/caddyfile/directives/tls#issuers)
- [frp：服务端绑定、允许端口和强制 TLS 配置](https://gofrp.org/en/docs/reference/server-configures/)

此安装固定用 HTTP-01 验证，**公网 TCP 80 必须一直可达**，包括后续续期；非 443 的 HTTPS 端口不能代替 ACME 的 80。80 端口由 Caddy 在验证时提供 challenge，不向 frps 转发业务。云厂商安全组与 VPS 防火墙均需放行 TCP 80、7000（或自定义传输端口）、8443/8444（或实际 HTTPS 端口）。无需开放 18001/18002，也无需 UDP。保留 SSH 访问规则。已启用 UFW 时可按实际映射执行：

```sh
sudo ufw allow 80/tcp
sudo ufw allow 7000/tcp
sudo ufw allow 8443/tcp
sudo ufw allow 8444/tcp
```

不要为部署直接执行 `ufw reset` 或盲目启用防火墙，以免锁住 SSH。公网地址必须真正属于此 VPS；NAT 转发需把 80 和全部业务/传输端口转到同一 VPS。出站需允许 DNS 与 HTTPS 以完成下载、ACME 签发和续期。短期证书依赖连续运行与准确系统时钟。

验证与排障：

```sh
sudo systemctl status vermillion-frps vermillion-caddy
sudo journalctl -u vermillion-caddy -u vermillion-frps --since '10 minutes ago'
sudo ss -lntp
curl -v https://YOUR_PUBLIC_IP:8443/
```

`curl` 从另一台机器执行，不加 `-k`：证书应通过系统信任校验；尚未配对时允许业务返回 401。桌面隧道未接入时 Caddy 会返回 502。`ss` 中 frps 业务端口应只在 `127.0.0.1`，并且只有客户端成功注册后才出现。配置验证不会申请生产证书，不能将 `validate` 成功当成公网签发成功；签发失败先检查公网 80、地址归属、DNS、时钟与 Caddy 日志。没有真实 VPS 时，公网签发必须作为部署现场验收完成。

## 桌面 frpc

使用 [frp v0.71.0 官方 release](https://github.com/fatedier/frp/releases/tag/v0.71.0) 对应系统和 CPU 的包，同时下载 `frp_sha256_checksums.txt`，核对压缩包 SHA256 后解压。Vermillion 管理 frpc 生命周期，不额外创建开机隧道服务。远程设置中填写 VPS 地址、7000、token，并选择 frpc 路径和传输 CA 文件路径。

通过已验证主机指纹的 SSH 连接，将公开 CA 证书复制到每台桌面（Mac/Windows OpenSSH 命令相同）：

```sh
scp YOUR_SSH_HOST:/etc/vermillion-remote/frp-ca.crt ./frp-ca.crt
```

在桌面选择此文件的绝对路径作为 frp 可信 CA。`serverAddr` 应与安装时的 `--host` 一致；若使用另一连接地址，`transport.tls.serverName` 必须明确设为证书对应的原地址。CA 文件本身不是秘密，但必须通过可信通道取得，不能从未认证的 HTTP 链接下载。不要把 CA 私钥复制到桌面。应用未提供可信 CA 字段的版本不能安全使用此部署，应先更新应用。

**端口对应关系：** Mac 的后端端口 `remotePort` 填 **18001**，公网 HTTPS 端口 `publicPort` 填 **8443**；PC 分别填 **18002** 与 **8444**。`publicPort` 默认 443，需按部署映射修改。公网地址 `publicUrl` 可留空，由 VPS 地址和 `publicPort` 自动组成（Mac 为 `https://YOUR_PUBLIC_IP:8443`）；需要使用其他公网地址时再填写覆盖值。公网 HTTPS 端口不能填入 frpc `remotePort`。桌面网关 `localIP` 为 `127.0.0.1`，本地端口由桌面网关状态确定。

macOS：Apple Silicon 下载 `frp_0.71.0_darwin_arm64.tar.gz`，Intel 下载 `darwin_amd64`。以下以 Apple Silicon 为例，在下载目录执行：

```sh
shasum -a 256 frp_0.71.0_darwin_arm64.tar.gz
# 与官方清单的同名条目逐字核对后继续
tar -xzf frp_0.71.0_darwin_arm64.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 755 frp_0.71.0_darwin_arm64/frpc "$HOME/.local/bin/frpc"
"$HOME/.local/bin/frpc" --version
```

在应用选择绝对路径，避免 GUI 启动时 PATH 不含 `~/.local/bin`。如 Gatekeeper 阻止已经核验来源和校验和的程序，可在系统设置「隐私与安全性」允许该具体程序，不关闭系统安全检查。

Windows：下载 `frp_0.71.0_windows_amd64.zip`（ARM 设备选 `windows_arm64`）。PowerShell 中执行：

```powershell
Get-FileHash .\frp_0.71.0_windows_amd64.zip -Algorithm SHA256
# 与官方清单的同名条目逐字核对后继续
Expand-Archive .\frp_0.71.0_windows_amd64.zip -DestinationPath "$env:LOCALAPPDATA\Vermillion\tools\frp-0.71.0"
& "$env:LOCALAPPDATA\Vermillion\tools\frp-0.71.0\frp_0.71.0_windows_amd64\frpc.exe" --version
```

把最终 `frpc.exe` 的完整路径选入应用。默认不添加 Defender 排除。只有 Windows 安全中心「保护历史记录」确实显示此已验证二进制被拦截，并在复核 release 来源和 SHA256 后，才允许该具体文件；确需排除时以管理员 PowerShell 执行 `Add-MpPreference -ExclusionPath 'C:\实际路径\frpc.exe'`。不要排除整个目录、用户目录或进程，不关闭实时保护。取消排除用相同路径的 `Remove-MpPreference -ExclusionPath`。Defender 没有拦截时，路径错误、权限错误或连接失败应按原始错误排查。

桌面仅需出站 TCP 到 VPS 传输端口，不开放桌面公网入站端口。frpc 配置必须同时设置 `transport.tls.enable = true` 与 `transport.tls.trustedCaFile`，服务端拒绝明文传输。frp 0.71.0 在未设置可信 CA 时跳过服务端证书校验；只打开 TLS 无法阻止主动中间人。此行为已核对 [frp 客户端 TLS 源码](https://github.com/fatedier/frp/blob/v0.71.0/pkg/transport/tls.go)；[连接器](https://github.com/fatedier/frp/blob/v0.71.0/client/connector.go) 默认以 `serverAddr` 检查证书名称。安装生成的服务端证书与桌面固定信任的 CA 配合，认证 VPS 身份。

独立 CLI 排查可创建权限受限的 frpc TOML，随后执行 `frpc verify -c /path/frpc.toml` 与 `frpc -c /path/frpc.toml`。勿与应用同时申请同一回环端口。示例只用于说明字段，token 文件需自行创建并保护：

```toml
serverAddr = "YOUR_PUBLIC_IP"
serverPort = 7000
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/absolute/private/frp-token"
transport.tls.enable = true
transport.tls.trustedCaFile = "/absolute/path/frp-ca.crt"
loginFailExit = false

[[proxies]]
name = "mac-mobile"
type = "tcp"
localIP = "127.0.0.1"
localPort = 32123 # 替换为桌面网关实际端口
remotePort = 18001
```

## 电脑防休眠

桌面应用、frpc 和网络必须持续在线。Mac 接电时在系统设置「电池/节能」开启显示器关闭时防止自动睡眠；笔记本合盖仍可能休眠，按 Apple 支持的外接显示器模式使用或保持开盖。临时接电运行可执行 `caffeinate -s`，保持该终端直到不再需要远程访问。Windows 在「系统 → 电源和电池 → 屏幕和睡眠」把接电睡眠设置为「从不」，并检查合盖行为。可关闭屏幕，不必保持亮屏。不修改电池模式以免耗尽电量。
