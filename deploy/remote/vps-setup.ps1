$ErrorActionPreference = 'Stop'
# Windows' built-in OpenSSH is used; the token is entered on the VPS terminal.
Get-Command ssh.exe, scp.exe -ErrorAction Stop | Out-Null
$destination = Read-Host 'SSH destination (user@host or configured SSH alias)'
if ($destination -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$') { throw 'Invalid SSH destination; use an SSH alias for IPv6 or a nondefault SSH port.' }
$publicHost = Read-Host 'Public VPS IP or domain (without scheme or port)'
if ($publicHost -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$') { throw 'Invalid public host' }
$maps = (Read-Host 'HTTPS:LOOPBACK mappings separated by spaces (example: 8443:18001 8444:18002)').Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
if ($maps.Count -eq 0) { throw 'At least one mapping is required' }
foreach ($mapping in $maps) { if ($mapping -notmatch '^\d{1,5}:\d{1,5}$') { throw 'Invalid mapping' } }
$frpPort = Read-Host 'FRP transport port (Enter for 7000)'
if (!$frpPort) { $frpPort = '7000' }
if ($frpPort -notmatch '^\d{1,5}$') { throw 'Invalid FRP port' }
$remoteDir = '/tmp/vermillion-deploy-' + [Guid]::NewGuid().ToString('N')
& ssh.exe $destination "umask 077 && mkdir '$remoteDir'"
if ($LASTEXITCODE -ne 0) { throw 'Cannot create private upload directory on VPS' }
try {
    $files = @('vps-setup.sh', 'render-config.py', 'prepare-tls.py', 'vermillion-frps.service', 'vermillion-caddy.service') | ForEach-Object { Join-Path $PSScriptRoot $_ }
    & scp.exe @files "${destination}:$remoteDir/"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
    $mappingArgs = ($maps | ForEach-Object { "--map '$_'" }) -join ' '
    & ssh.exe -t $destination "sudo bash '$remoteDir/vps-setup.sh' --host '$publicHost' --frp-port '$frpPort' $mappingArgs"
    if ($LASTEXITCODE -ne 0) { throw 'VPS setup failed; inspect the error above' }
} finally {
    & ssh.exe $destination "rm -rf -- '$remoteDir'"
    if ($LASTEXITCODE -ne 0) { Write-Warning "Remove upload directory manually: $remoteDir" }
}
