param([switch]$Uninstall, [switch]$NoProfile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Sealbridge'
$nodeVersion = '22.22.0'
$package = 'sealbridge@0.2.1'
$nodeDir = Join-Path $root 'node'
$npmDir = Join-Path $root 'npm'

function Get-SealbridgeNode {
    param([string]$Prefix)
    # npm's Windows shims prefer node.exe beside the shim, then search PATH.
    $node = Join-Path $Prefix 'node.exe'
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (!$command) { return $null }
        $node = $command.Source
    }
    try {
        $version = & $node -p process.versions.node
        if ($LASTEXITCODE -ne 0) { return $null }
        $version = "$version".Trim()
        $major = 0
        if ($version -notmatch '^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or ![int]::TryParse($Matches[1], [ref]$major)) { return $null }
        $resolvedPath = & $node -p process.execPath
        if ($LASTEXITCODE -ne 0 -or !$resolvedPath) { return $null }
        return [PSCustomObject]@{ Path = "$resolvedPath".Trim(); Version = $version; Supported = $major -ge 22 }
    } catch { return $null }
}

try {
    if ($Uninstall) {
        if (!(Test-Path -LiteralPath (Join-Path $root '.installer-owned'))) { throw 'No installer-owned installation found; nothing removed.' }
        $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Sealbridge'))
        if ([IO.Path]::GetFullPath($root) -ne $expected) { throw 'Unsafe uninstall path.' }
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $kept = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $nodeDir -and $_ -ne $npmDir })
        if (!$NoProfile) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User') }
        $env:Path = (@($env:Path -split ';' | Where-Object { $_ -ne $nodeDir -and $_ -ne $npmDir }) -join ';')
        Remove-Item -LiteralPath $expected -Recurse -Force
        Write-Host 'Removed Sealbridge. Your keys are preserved.'
        return
    }
    if ((Test-Path -LiteralPath $root) -and !(Test-Path -LiteralPath (Join-Path $root '.installer-owned'))) { throw 'Installation directory already exists without an ownership marker.' }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Set-Content -LiteralPath (Join-Path $root '.installer-owned') -Value 'Sealbridge installer'
    $env:Path = "$nodeDir;$npmDir;$env:Path"
    $runtime = Get-SealbridgeNode -Prefix $npmDir
    if (!$runtime -or !$runtime.Supported) {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'x64' } else { throw 'Windows x64 or arm64 is required.' }
        $file = "node-v$nodeVersion-win-$arch.zip"
        $download = Join-Path $root ('download-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $download | Out-Null
        $archive = Join-Path $download $file
        Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$file" -OutFile $archive -UseBasicParsing
        $checksums = (Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
        $expectedHash = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $file") }) -replace '\s+.*$', ''
        if (!$expectedHash -or $expectedHash.Length -ne 64 -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Node checksum mismatch; installation stopped.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $download
        New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
        Copy-Item -Path (Join-Path $download "node-v$nodeVersion-win-$arch/*") -Destination $nodeDir -Recurse -Force
        # A prefix-local runtime would otherwise keep overriding the downloaded Node.
        if (Test-Path -LiteralPath (Join-Path $npmDir 'node.exe') -PathType Leaf) {
            Copy-Item -LiteralPath (Join-Path $nodeDir 'node.exe') -Destination (Join-Path $npmDir 'node.exe') -Force
        }
        $resolvedDownload = [IO.Path]::GetFullPath($download)
        if (!$resolvedDownload.StartsWith([IO.Path]::GetFullPath($root) + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe temporary path.' }
        Remove-Item -LiteralPath $resolvedDownload -Recurse -Force
    }
    if (!(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node is present but npm is missing. Install Node with npm and rerun.' }
    if ($env:SEALBRIDGE_INSTALL_TARBALL) {
        if (!(Test-Path -LiteralPath $env:SEALBRIDGE_INSTALL_TARBALL -PathType Leaf)) { throw 'Local test tarball does not exist.' }
        $package = $env:SEALBRIDGE_INSTALL_TARBALL
    }
    & npm.cmd install --global --prefix $npmDir --ignore-scripts --no-audit --no-fund $package
    if ($LASTEXITCODE -ne 0) { throw 'npm installation failed.' }
    $runtime = Get-SealbridgeNode -Prefix $npmDir
    if (!$runtime -or !$runtime.Supported) { throw 'The installed CLI requires Node 22 or newer. Check the npm prefix and PATH, then rerun the installer.' }
    Write-Host "Node.js: $($runtime.Version) ($($runtime.Path))"
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $nodeDir -and $_ -ne $npmDir })
    if (!$NoProfile) { [Environment]::SetEnvironmentVariable('Path', ((@($nodeDir, $npmDir) + $parts) -join ';'), 'User') }
    & (Join-Path $npmDir 'sealbridge.cmd') --version
    if ($LASTEXITCODE -ne 0) { throw 'Installed CLI did not start.' }
    & (Join-Path $npmDir 'sealbridge.cmd') doctor
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Installed, but doctor found an issue. Follow its fixes and rerun sealbridge doctor.' }
    Write-Host 'Installed. Run sealbridge demo. Uninstall: & ./install.ps1 -Uninstall'
} catch { throw "Sealbridge installation failed: $_" }
