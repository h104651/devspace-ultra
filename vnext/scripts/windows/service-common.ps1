# Shared management identity: all launchers resolve one service-config.json through the same Node resolver.
function Resolve-NodeExe {
    $candidates = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'node.exe not found.'
}

function Test-SameServicePath([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    return [IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [IO.Path]::GetFullPath($B).TrimEnd('\')
}

function Get-ServiceContext([string]$LauncherDir, [string]$DeviceId = '', [string]$ConfigDir = '', [string]$ReleaseDir = '') {
    $launcher = (Resolve-Path -LiteralPath $LauncherDir).Path
    $node = Resolve-NodeExe
    $raw = & $node (Join-Path $launcher 'service-config.js')
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw 'Service configuration cannot be resolved.' }
    $ctx = $raw | ConvertFrom-Json
    if (-not $ctx.deviceId) { throw 'Service device identity missing.' }
    if ($DeviceId -and $ctx.deviceId -ine $DeviceId) { throw 'Requested DeviceId does not match launcher configuration.' }
    if ($ConfigDir -and -not (Test-SameServicePath $ConfigDir $ctx.configDir)) { throw 'Requested ConfigDir does not match launcher configuration.' }
    if ($ReleaseDir -and -not (Test-SameServicePath $ReleaseDir $ctx.releaseDir)) { throw 'Requested ReleaseDir does not match launcher configuration.' }
    $ctx | Add-Member -NotePropertyName nodeExe -NotePropertyValue $node
    $ctx | Add-Member -NotePropertyName launcherDir -NotePropertyValue $launcher
    $ctx | Add-Member -NotePropertyName ipcScript -NotePropertyValue (Join-Path $launcher 'ipc-control.js')
    $ctx | Add-Member -NotePropertyName vbsPath -NotePropertyValue (Join-Path $launcher 'launch-daemon.vbs')
    return $ctx
}

function Get-PrincipalSid([string]$Principal) {
    if ($Principal -match '^S-\d-') { return $Principal }
    return ([System.Security.Principal.NTAccount]::new($Principal)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Assert-ServiceTask($Task, $Context) {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ((Get-PrincipalSid $Task.Principal.UserId) -ne $currentSid) { throw 'Scheduled task principal does not match current user.' }
    if (@($Task.Actions).Count -ne 1) { throw 'Unexpected scheduled task actions.' }
    $action = @($Task.Actions)[0]
    $expectedExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if (-not (Test-SameServicePath $action.Execute $expectedExe) -or
        $action.Arguments.Trim() -ine ('"' + $Context.vbsPath + '"') -or
        -not (Test-SameServicePath $action.WorkingDirectory $Context.launcherDir)) {
        throw 'Scheduled task points to another launcher. Use explicit audited migration instead.'
    }
}

function Get-ServiceIpcStatus($Context) {
    $raw = & $Context.nodeExe $Context.ipcScript status --device-id $Context.deviceId --json 2>$null
    if (-not $raw) { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Assert-ServiceStatus($Status, $Context, [switch]$RequireWorker) {
    if (-not $Status -or -not $Status.ok -or $Status.deviceId -ine $Context.deviceId -or
        -not (Test-SameServicePath $Status.configDir $Context.configDir) -or
        -not (Test-SameServicePath $Status.releaseDir $Context.releaseDir)) { throw 'IPC service identity mismatch.' }
    if (-not $Status.daemonPid) { throw 'Daemon PID missing.' }
    $daemon = Get-CimInstance Win32_Process -Filter "ProcessId = $($Status.daemonPid)" -ErrorAction Stop
    $daemonPath = Join-Path $Context.launcherDir 'agent-daemon.js'
    if (-not $daemon -or $daemon.Name -ine 'node.exe' -or
        $daemon.CommandLine.IndexOf($daemonPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Daemon executable or command line does not match target launcher.'
    }
    if ($Status.startedAt) {
        $actualStart = ([DateTimeOffset]$daemon.CreationDate).ToUnixTimeMilliseconds()
        if ([Math]::Abs($actualStart - [long]$Status.startedAt) -gt 15000) { throw 'Daemon creation time mismatch.' }
    } else { throw 'Daemon creation-time evidence missing.' }
    if ($Status.agentPid) {
        $worker = Get-CimInstance Win32_Process -Filter "ProcessId = $($Status.agentPid)" -ErrorAction Stop
        $entry = Join-Path $Context.releaseDir 'dist\cli\agent-cli.js'
        if (-not $worker -or $worker.Name -ine 'node.exe' -or $worker.ParentProcessId -ne $Status.daemonPid -or
            $worker.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            -not $Status.lockExists -or $Status.lockOwnerPid -ne $Status.agentPid) { throw 'Worker parent, executable, or lock ownership mismatch.' }
        $lock = Get-Content -LiteralPath $Status.lockPath -Raw | ConvertFrom-Json
        if ($lock.deviceId -ine $Context.deviceId -or $lock.pid -ne $Status.agentPid) { throw 'Worker lock identity mismatch.' }
        $workerStart = ([DateTimeOffset]$worker.CreationDate).ToUnixTimeMilliseconds()
        if ([Math]::Abs($workerStart - [long]$lock.startedAt) -gt 15000) { throw 'Worker creation time mismatch.' }
    } elseif ($RequireWorker) { throw 'Worker not running.' }
}
