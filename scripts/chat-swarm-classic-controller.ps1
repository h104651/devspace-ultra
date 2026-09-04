[CmdletBinding()]
param(
    [ValidateSet("setup", "start", "scale", "ensure", "status", "minimize", "restore", "stop", "repair", "capture", "recover", "autojoin", "help")]
    [string]$Action = "status",

    [ValidateRange(1, 32)]
    [int]$Count = 4,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [ValidateRange(1, 32)]
    [int]$Worker = 1,

    [string]$WorkerNumbers,

    [ValidateRange(0, 31)]
    [int]$DesiredWorkers = 4,

    [string]$ReservedWorkerNumbers = "",

    [string]$InviteCode,

    [string]$ProjectUrl,

    [ValidateRange(1024, 65000)]
    [int]$DebugBasePort = 9330,

    [ValidateRange(0, 120)]
    [int]$StaggerSeconds = 8,

    [switch]$EnableAutomation,

    [switch]$RestartForAutomation,

    [switch]$NoMinimize,

    [switch]$ForceRefresh
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "chat-swarm-desktop-resolver.ps1")

$runtimeCloneScript = Join-Path $PSScriptRoot "chat-swarm-classic-runtime-clone.ps1"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$stateRoot = Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic"
$statePath = Join-Path $stateRoot "controller-state.json"
$authSeedRoot = Join-Path $stateRoot "auth-seed"
$authSeedProfile = Join-Path $authSeedRoot "profile"
$authStateItems = @(
    "Local State",
    "Preferences",
    "Secure Preferences",
    "config.json",
    "Default",
    "Network",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
    "WebStorage",
    "shared_proto_db",
    "SharedStorage",
    "SharedStorage-wal",
    "Service Worker"
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ChatSwarmWindowApi {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@ -ErrorAction SilentlyContinue

function Get-ReservedWorkerNumbers {
    @($ReservedWorkerNumbers -split ',' | ForEach-Object {
        $value = 0
        if ([int]::TryParse($_.Trim(), [ref]$value) -and $value -ge 1 -and $value -le 32) { $value }
    } | Sort-Object -Unique)
}

function Get-WorkerNumberRange {
    if (-not [string]::IsNullOrWhiteSpace($WorkerNumbers)) {
        $parsed = @($WorkerNumbers -split ',' | ForEach-Object {
            $value = 0
            if (-not [int]::TryParse($_.Trim(), [ref]$value) -or $value -lt 1 -or $value -gt 32) {
                throw "WorkerNumbers must contain integers from 1 to 32."
            }
            $value
        } | Sort-Object -Unique)
        if ($parsed.Count -eq 0) { throw "WorkerNumbers did not contain any valid worker numbers." }
        return $parsed
    }
    @($FirstWorker..($FirstWorker + $Count - 1))
}

function Get-ProductionWorkerNumbers {
    param([Parameter(Mandatory)][int]$Desired)
    $reserved = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($number in @(Get-ReservedWorkerNumbers)) { [void]$reserved.Add([int]$number) }
    $available = @()
    for ($number = 1; $number -le 32; $number++) {
        if (-not $reserved.Contains($number)) { $available += $number }
    }
    if ($Desired -gt $available.Count) {
        throw "Requested $Desired production workers but only $($available.Count) runtime numbers are available after reserved workers: $((Get-ReservedWorkerNumbers) -join ',')."
    }
    @($available | Select-Object -First $Desired)
}

function Get-WorkerRuntime {
    param([Parameter(Mandatory)][int]$Number)

    $workerInfo = Resolve-ChatGPTDesktopPackage -WorkerNumber $Number
    if (-not $workerInfo.Registered) {
        return [pscustomobject]@{
            Number            = $Number
            WorkerId          = $workerInfo.WorkerId
            Label             = $workerInfo.Label
            PackageName       = $workerInfo.PackageName
            PackageFamilyName = $null
            InstallLocation   = $null
            ExecutablePath    = $null
            AliasPath         = $workerInfo.AliasPath
            ProfilePath       = $null
            DebugPort         = $DebugBasePort + $Number
            Registered        = $false
            ProcessName       = $workerInfo.ProcessName
        }
    }

    [pscustomobject]@{
        Number            = $Number
        WorkerId          = $workerInfo.WorkerId
        Label             = $workerInfo.Label
        PackageName       = $workerInfo.PackageName
        PackageFamilyName = $workerInfo.PackageFamilyName
        InstallLocation   = $workerInfo.InstallLocation
        ExecutablePath    = $workerInfo.ExecutablePath
        AliasPath         = $workerInfo.AliasPath
        ProfilePath       = $workerInfo.ProfilePath
        DebugPort         = $DebugBasePort + $Number
        Registered        = $true
        ProcessName       = $workerInfo.ProcessName
    }
}

function Get-WorkerRootProcess {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered -or -not $Runtime.ExecutablePath) { return $null }

    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq $Runtime.ProcessName -and
            $_.ExecutablePath -eq $Runtime.ExecutablePath -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Sort-Object CreationDate |
        Select-Object -First 1
}

function Test-TcpPort {
    param([Parameter(Mandatory)][int]$Port)
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(250)) { $client.Dispose(); return $false }
        $ok = $client.Connected
        $client.Dispose()
        return $ok
    }
    catch { return $false }
}

function Read-ControllerState {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    try { return (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) }
    catch { return $null }
}

function Save-ControllerState {
    param([Parameter(Mandatory)][object[]]$Runtimes)
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

    $byNumber = @{}
    $existing = Read-ControllerState
    if ($existing) {
        foreach ($item in @($existing.workers)) {
            if ($null -eq $item.number) { continue }
            $byNumber[[int]$item.number] = [ordered]@{
                number = [int]$item.number
                workerId = [string]$item.workerId
                label = [string]$item.label
                debugPort = [int]$item.debugPort
                conversationUrl = [string]$item.conversationUrl
                projectUrl = [string]$item.projectUrl
                updatedAt = [string]$item.updatedAt
            }
        }
    }

    $timestamp = (Get-Date).ToUniversalTime().ToString("o")
    foreach ($runtime in $Runtimes) {
        $current = if ($byNumber.ContainsKey($runtime.Number)) { $byNumber[$runtime.Number] } else { $null }
        $byNumber[$runtime.Number] = [ordered]@{
            number = [int]$runtime.Number
            workerId = [string]$runtime.WorkerId
            label = [string]$runtime.Label
            debugPort = [int]$runtime.DebugPort
            conversationUrl = if ($current) { [string]$current.conversationUrl } else { "" }
            projectUrl = if ($current) { [string]$current.projectUrl } else { "" }
            updatedAt = $timestamp
        }
    }

    $workerList = @($byNumber.Values | Sort-Object { [int]$_.number })
    $payload = [ordered]@{
        version = 1
        updatedAt = $timestamp
        productionDesired = if ($existing -and $null -ne $existing.productionDesired) { [int]$existing.productionDesired } else { $null }
        reservedWorkerNumbers = if ($existing -and $null -ne $existing.reservedWorkerNumbers) { @($existing.reservedWorkerNumbers) } else { @(Get-ReservedWorkerNumbers) }
        workers = $workerList
    }

    $json = $payload | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($statePath, $json, [System.Text.Encoding]::UTF8)
}

function Set-ProductionDesired {
    param([Parameter(Mandatory)][int]$Desired)
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $existing = Read-ControllerState
    $timestamp = (Get-Date).ToUniversalTime().ToString("o")
    $payload = [ordered]@{
        version = 1
        updatedAt = $timestamp
        productionDesired = $Desired
        reservedWorkerNumbers = @(Get-ReservedWorkerNumbers)
        workers = if ($existing -and $existing.workers) { @($existing.workers) } else { @() }
    }
    $json = $payload | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($statePath, $json, [System.Text.Encoding]::UTF8)
}

function Set-WorkerConversationUrl {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$Url
    )
    Save-ControllerState -Runtimes @($Runtime)
    $state = Read-ControllerState
    if (-not $state) { return }
    $found = $false
    foreach ($item in @($state.workers)) {
        if ([int]$item.number -eq [int]$Runtime.Number) {
            $item.conversationUrl = $Url
            $item.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
            $found = $true
            break
        }
    }
    if ($found) {
        $json = $state | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($statePath, $json, [System.Text.Encoding]::UTF8)
    }
}

function Get-ConfiguredProjectUrl {
    param([string]$ExplicitUrl)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitUrl)) { return $ExplicitUrl.Trim() }
    if ($env:DEVSPACE_CHATGPT_PROJECT_URL) { return $env:DEVSPACE_CHATGPT_PROJECT_URL.Trim() }

    $configPath = Join-Path $env:USERPROFILE ".devspace\config.json"
    if (Test-Path -LiteralPath $configPath) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            if ($config.chatSwarm.projectUrl) { return ([string]$config.chatSwarm.projectUrl).Trim() }
        } catch {}
    }
    return $null
}

function Get-WorkerConversationUrl {
    param([Parameter(Mandatory)]$Runtime)
    $state = Read-ControllerState
    if (-not $state) { return $null }
    foreach ($item in @($state.workers)) {
        if ([int]$item.number -eq [int]$Runtime.Number -and -not [string]::IsNullOrWhiteSpace($item.conversationUrl)) {
            return [string]$item.conversationUrl
        }
    }
    return $null
}

function Start-WorkerRuntime {
    param(
        [Parameter(Mandatory)]$Runtime,
        [switch]$Automation,
        [switch]$ForceRestart
    )

    if (-not $Runtime.Registered) {
        throw "$($Runtime.WorkerId) is not registered. Run setup first."
    }
    if (-not (Test-Path -LiteralPath $Runtime.AliasPath)) {
        throw "Execution alias is missing for $($Runtime.WorkerId): $($Runtime.AliasPath)"
    }

    $root = Get-WorkerRootProcess -Runtime $Runtime
    $debugOnline = Test-TcpPort -Port $Runtime.DebugPort

    if ($root -and $Automation -and -not $debugOnline -and $ForceRestart) {
        Stop-WorkerRuntime -Runtime $Runtime
        Start-Sleep -Milliseconds 700
        $root = $null
    }

    if (-not $root) {
        $args = @()
        if ($Automation) {
            $args += "--remote-debugging-address=127.0.0.1"
            $args += "--remote-debugging-port=$($Runtime.DebugPort)"
        }
        if ($args.Count -gt 0) {
            Start-Process -FilePath $Runtime.AliasPath -ArgumentList $args | Out-Null
        }
        else {
            Start-Process -FilePath $Runtime.AliasPath | Out-Null
        }

        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 350
            $root = Get-WorkerRootProcess -Runtime $Runtime
        } while (-not $root -and (Get-Date) -lt $deadline)

        if (-not $root) {
            throw "$($Runtime.WorkerId) did not start before timeout."
        }
    }

    if ($Automation) {
        $deadline = (Get-Date).AddSeconds(10)
        do {
            if (Test-TcpPort -Port $Runtime.DebugPort) { break }
            Start-Sleep -Milliseconds 300
        } while ((Get-Date) -lt $deadline)
    }

    $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{
        WorkerId     = $Runtime.WorkerId
        Pid          = $root.ProcessId
        Responding   = [bool]$process.Responding
        DebugPort    = $Runtime.DebugPort
        Automation   = (Test-TcpPort -Port $Runtime.DebugPort)
        WindowHandle = [long]$process.MainWindowHandle
        WindowTitle  = $process.MainWindowTitle
    }
}

function Stop-WorkerRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered -or -not $Runtime.ExecutablePath) { return }

    $processes = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq $Runtime.ProcessName -and
                $_.ExecutablePath -eq $Runtime.ExecutablePath
            }
    )
    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Set-WorkerWindowState {
    param(
        [Parameter(Mandatory)]$Runtime,
        [ValidateSet("minimize", "restore")]
        [string]$Mode = "minimize"
    )
    $root = Get-WorkerRootProcess -Runtime $Runtime
    if (-not $root) { return $false }
    $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.MainWindowHandle -eq 0) { return $false }

    if ($Mode -eq "minimize") {
        return [ChatSwarmWindowApi]::ShowWindow([IntPtr]$process.MainWindowHandle, 6)
    }
    [void][ChatSwarmWindowApi]::ShowWindow([IntPtr]$process.MainWindowHandle, 9)
    [void][ChatSwarmWindowApi]::SetForegroundWindow([IntPtr]$process.MainWindowHandle)
    return $true
}

function Get-WorkerStatusRow {
    param([Parameter(Mandatory)]$Runtime)
    $root = Get-WorkerRootProcess -Runtime $Runtime
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    $loggedIn = if ($Runtime.Registered -and $Runtime.ProfilePath) {
        Test-AuthProfile -ProfilePath $Runtime.ProfilePath
    } else { $false }

    [pscustomobject]@{
        Worker        = $Runtime.WorkerId
        Label         = $Runtime.Label
        Registered    = $Runtime.Registered
        Running       = [bool]$root
        Pid           = if ($root) { $root.ProcessId } else { $null }
        Responding    = if ($process) { [bool]$process.Responding } else { $false }
        LoggedInState = $loggedIn
        Automation    = Test-TcpPort -Port $Runtime.DebugPort
        DebugPort     = $Runtime.DebugPort
        WindowTitle   = if ($process) { $process.MainWindowTitle } else { "" }
        SavedUrl      = (Get-WorkerConversationUrl -Runtime $Runtime)
    }
}

function Copy-AuthStateItem {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$TargetRoot,
        [Parameter(Mandatory)][string]$RelativePath
    )
    $source = Join-Path $SourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) { return }
    $target = Join-Path $TargetRoot $RelativePath
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force

    # Clean ephemeral caches from target if copying whole Default folder
    if ($RelativePath -eq "Default") {
        foreach ($junk in @("Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "blob_storage", "lockfile", "LOCK", "LOG", "LOG.old")) {
            $junkPath = Join-Path $target $junk
            if (Test-Path -LiteralPath $junkPath) {
                Remove-Item -LiteralPath $junkPath -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Test-AuthProfile {
    param([string]$ProfilePath)
    if ([string]::IsNullOrWhiteSpace($ProfilePath)) { return $false }
    (Test-Path -LiteralPath (Join-Path $ProfilePath "IndexedDB")) -or
    (Test-Path -LiteralPath (Join-Path $ProfilePath "Default\Network\Cookies")) -or
    (Test-Path -LiteralPath (Join-Path $ProfilePath "Network\Cookies")) -or
    (Test-Path -LiteralPath (Join-Path $ProfilePath "Local State"))
}

function Ensure-AuthSeed {
    if (Test-AuthProfile -ProfilePath $authSeedProfile) { return "existing" }

    $reserved = @(Get-ReservedWorkerNumbers)
    $sourceRuntime = $null
    for ($number = 1; $number -le 32; $number++) {
        if ($reserved -contains $number) { continue }
        $candidate = Get-WorkerRuntime -Number $number
        if ($candidate.Registered -and (Test-AuthProfile -ProfilePath $candidate.ProfilePath)) {
            $sourceRuntime = $candidate
            break
        }
    }

    $sourceProfilePath = $null
    $sourceLabel = $null
    if ($sourceRuntime) {
        $wasRunning = [bool](Get-WorkerRootProcess -Runtime $sourceRuntime)
        if ($wasRunning) {
            Stop-WorkerRuntime -Runtime $sourceRuntime
            Start-Sleep -Milliseconds 900
        }
        $sourceProfilePath = $sourceRuntime.ProfilePath
        $sourceLabel = $sourceRuntime.WorkerId
    } else {
        $primaryInfo = Resolve-ChatGPTDesktopPackage
        if ($primaryInfo.IsInstalled -and (Test-AuthProfile -ProfilePath $primaryInfo.ProfilePath)) {
            $sourceProfilePath = $primaryInfo.ProfilePath
            $sourceLabel = "primary-$($primaryInfo.PackageName)"
        }
    }

    if (-not $sourceProfilePath) {
        throw "No authenticated production worker or primary app is available to seed new runtimes. Log into ChatGPT first."
    }

    if (Test-Path -LiteralPath $authSeedProfile) { Remove-Item -LiteralPath $authSeedProfile -Recurse -Force }
    New-Item -ItemType Directory -Path $authSeedProfile -Force | Out-Null
    foreach ($item in $authStateItems) {
        Copy-AuthStateItem -SourceRoot $sourceProfilePath -TargetRoot $authSeedProfile -RelativePath $item
    }
    if (-not (Test-AuthProfile -ProfilePath $authSeedProfile)) {
        throw "Authentication seed capture failed: Profile state is missing from the seed."
    }
    return "captured-from-$sourceLabel"
}

function Apply-AuthSeed {
    param([Parameter(Mandatory)]$Runtime)
    if (Test-AuthProfile -ProfilePath $Runtime.ProfilePath) { return $false }
    if (-not (Test-AuthProfile -ProfilePath $authSeedProfile)) { [void](Ensure-AuthSeed) }
    Stop-WorkerRuntime -Runtime $Runtime
    New-Item -ItemType Directory -Path $Runtime.ProfilePath -Force | Out-Null
    foreach ($item in $authStateItems) {
        Copy-AuthStateItem -SourceRoot $authSeedProfile -TargetRoot $Runtime.ProfilePath -RelativePath $item
    }
    if (-not (Test-AuthProfile -ProfilePath $Runtime.ProfilePath)) {
        throw "Failed to provision login state for $($Runtime.WorkerId)."
    }
    return $true
}

function Ensure-OneRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-AuthProfile -ProfilePath $Runtime.ProfilePath)) { [void](Apply-AuthSeed -Runtime $Runtime) }

    $root = Get-WorkerRootProcess -Runtime $Runtime
    $automation = Test-TcpPort -Port $Runtime.DebugPort

    if (-not $root -or -not $automation) {
        [void](Start-WorkerRuntime -Runtime $Runtime -Automation -ForceRestart)
    }

    $url = Get-WorkerConversationUrl -Runtime $Runtime
    if ($url) {
        $probeResult = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--probe", "--compact")
        $probe = $probeResult.probe
        if ($probe.throttled) {
            $cleanup = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--dismiss-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $probe = $cleanup.afterDismiss
        }
        if (-not $probe.composer) {
            $cleanup = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--dismiss-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $probe = $cleanup.afterDismiss
        }
        if ($probe.connectionInterrupted) {
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--interrupt-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            Start-Sleep -Milliseconds 400
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--resume", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
        }
        elseif (-not $probe.generating -and $probe.composer -and -not $probe.composerDisabled -and $probe.composerTextLength -eq 0) {
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--resume", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
        }
    }

    if (-not $NoMinimize) {
        Start-Sleep -Milliseconds 400
        [void](Set-WorkerWindowState -Runtime $Runtime -Mode minimize)
    }

    $status = Get-WorkerStatusRow -Runtime $Runtime
    [pscustomobject]@{
        Worker          = $status.Worker
        Label           = $status.Label
        State           = "ensured-healthy"
        Running         = $status.Running
        Responding      = $status.Responding
        LoggedIn        = $status.LoggedInState
        Automation      = $status.Automation
        ConversationUrl = $status.SavedUrl
    }
}

function Invoke-CdpHelper {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    if (-not (Test-TcpPort -Port $Runtime.DebugPort)) {
        throw "$($Runtime.WorkerId) automation port $($Runtime.DebugPort) is offline."
    }
    if (-not (Test-Path -LiteralPath $bootstrapScript)) {
        throw "CDP bootstrap helper is missing: $bootstrapScript"
    }

    $commandArguments = @($bootstrapScript, "--port", [string]$Runtime.DebugPort, "--compact") + $Arguments
    $text = & node @commandArguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "CDP helper failed for $($Runtime.WorkerId) with exit code $LASTEXITCODE. Output: $text"
    }
    try {
        return ($text | ConvertFrom-Json)
    }
    catch { throw "CDP helper returned invalid JSON for $($Runtime.WorkerId): $text" }
}

function Convert-ToCanonicalConversationUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    try {
        $uri = [System.Uri]::new($Url.Trim())
        if ($uri.Host -ne "chatgpt.com") { return $null }
        if ($uri.AbsolutePath -match '^/c/[0-9a-fA-F-]+$' -or $uri.AbsolutePath -match '^/g/g-p-[^/]+/c/[0-9a-fA-F-]+$') {
            return "https://chatgpt.com" + $uri.AbsolutePath
        }
        return $null
    }
    catch { return $null }
}

function Invoke-AutoJoin {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-AuthProfile -ProfilePath $Runtime.ProfilePath)) { [void](Apply-AuthSeed -Runtime $Runtime) }
    [void](Start-WorkerRuntime -Runtime $Runtime -Automation)

    if ([string]::IsNullOrWhiteSpace($InviteCode)) {
        throw "autojoin requires -InviteCode."
    }

    $effectiveProjectUrl = Get-ConfiguredProjectUrl -ExplicitUrl $ProjectUrl
    $arguments = @("--invite", $InviteCode.Trim(), "--label", $Runtime.Label)
    if ($effectiveProjectUrl) {
        $arguments += @("--project-url", $effectiveProjectUrl)
    }
    else {
        $arguments += "--new-chat"
    }

    $result = Invoke-CdpHelper -Runtime $Runtime -Arguments $arguments
    Start-Sleep -Seconds 2
    $probe = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--probe")
    $url = Convert-ToCanonicalConversationUrl -Url ([string]$probe.probe.href)
    if ($url) {
        Set-WorkerConversationUrl -Runtime $Runtime -Url $url
    }
    if (-not $NoMinimize) {
        [void](Set-WorkerWindowState -Runtime $Runtime -Mode minimize)
    }
    return $result
}

$runtimes = @(Get-WorkerNumberRange | ForEach-Object { Get-WorkerRuntime -Number $_ })

switch ($Action) {
    "setup" {
        if (-not (Test-Path -LiteralPath $runtimeCloneScript)) {
            throw "Runtime clone helper is missing: $runtimeCloneScript"
        }
        & $runtimeCloneScript -Count $Count -FirstWorker $FirstWorker -ForceRefresh:$ForceRefresh
        $runtimes = @(Get-WorkerNumberRange | ForEach-Object { Get-WorkerRuntime -Number $_ })
        Save-ControllerState -Runtimes $runtimes
        $runtimes | ForEach-Object { Get-WorkerStatusRow -Runtime $_ } | Format-Table -AutoSize
    }
    "start" {
        Save-ControllerState -Runtimes $runtimes
        $started = foreach ($runtime in $runtimes) {
            Start-WorkerRuntime -Runtime $runtime -Automation:$EnableAutomation -ForceRestart:$RestartForAutomation
        }
        if (-not $NoMinimize) {
            Start-Sleep -Seconds 1
            foreach ($runtime in $runtimes) { [void](Set-WorkerWindowState -Runtime $runtime -Mode minimize) }
        }
        $started | Format-Table -AutoSize
    }
    "scale" {
        $targetNumbers = @(Get-ProductionWorkerNumbers -Desired $DesiredWorkers)
        $targetSet = [System.Collections.Generic.HashSet[int]]::new()
        foreach ($number in $targetNumbers) { [void]$targetSet.Add([int]$number) }

        $existingTargets = @($targetNumbers | ForEach-Object { Get-WorkerRuntime -Number $_ })
        $missing = @($existingTargets | Where-Object { -not $_.Registered })
        $needsAuth = @($existingTargets | Where-Object { $_.Registered -and -not (Test-AuthProfile -ProfilePath $_.ProfilePath) })
        if ($missing.Count -gt 0 -or $needsAuth.Count -gt 0) { [void](Ensure-AuthSeed) }

        foreach ($runtime in $missing) {
            & $runtimeCloneScript -Count 1 -FirstWorker $runtime.Number
        }
        $targetRuntimes = @($targetNumbers | ForEach-Object { Get-WorkerRuntime -Number $_ })
        foreach ($runtime in $targetRuntimes) {
            if (-not (Test-AuthProfile -ProfilePath $runtime.ProfilePath)) { [void](Apply-AuthSeed -Runtime $runtime) }
        }

        Save-ControllerState -Runtimes $targetRuntimes
        Set-ProductionDesired -Desired $DesiredWorkers

        $rows = @()
        foreach ($runtime in $targetRuntimes) { $rows += Ensure-OneRuntime -Runtime $runtime }

        $reserved = @(Get-ReservedWorkerNumbers)
        for ($number = 1; $number -le 32; $number++) {
            if ($reserved -contains $number -or $targetSet.Contains($number)) { continue }
            $runtime = Get-WorkerRuntime -Number $number
            if (-not $runtime.Registered) { continue }
            if (Get-WorkerRootProcess -Runtime $runtime) {
                Stop-WorkerRuntime -Runtime $runtime
                $rows += [pscustomobject]@{
                    Worker          = $runtime.WorkerId
                    Label           = $runtime.Label
                    State           = "scaled-down-stopped"
                    Running         = $false
                    Responding      = $false
                    LoggedIn        = (Test-AuthProfile -ProfilePath $runtime.ProfilePath)
                    Automation      = $false
                    ConversationUrl = (Get-WorkerConversationUrl -Runtime $runtime)
                }
            }
        }
        $rows | Format-Table -AutoSize
    }
    "ensure" {
        Save-ControllerState -Runtimes $runtimes
        $rows = foreach ($runtime in $runtimes) { Ensure-OneRuntime -Runtime $runtime }
        $rows | Format-Table -AutoSize
    }
    "status" {
        $runtimes | ForEach-Object { Get-WorkerStatusRow -Runtime $_ } | Format-Table -AutoSize
    }
    "minimize" {
        $rows = foreach ($runtime in $runtimes) {
            [pscustomobject]@{ Worker = $runtime.WorkerId; Minimized = [bool](Set-WorkerWindowState -Runtime $runtime -Mode minimize) }
        }
        $rows | Format-Table -AutoSize
    }
    "restore" {
        $runtime = Get-WorkerRuntime -Number $Worker
        [pscustomobject]@{ Worker = $runtime.WorkerId; Restored = [bool](Set-WorkerWindowState -Runtime $runtime -Mode restore) } | Format-List
    }
    "stop" {
        foreach ($runtime in $runtimes) { Stop-WorkerRuntime -Runtime $runtime }
        Start-Sleep -Milliseconds 600
        $runtimes | ForEach-Object { Get-WorkerStatusRow -Runtime $_ } | Format-Table -AutoSize
    }
    "repair" {
        $runtime = Get-WorkerRuntime -Number $Worker
        if (-not $runtime.Registered) {
            throw "$($runtime.WorkerId) is not registered. Use setup instead."
        }
        Stop-WorkerRuntime -Runtime $runtime
        Start-Sleep -Milliseconds 700
        Start-WorkerRuntime -Runtime $runtime -Automation:$EnableAutomation -ForceRestart | Format-List
    }
    "capture" {
        Save-ControllerState -Runtimes $runtimes
        $rows = foreach ($runtime in $runtimes) {
            try {
                $probeResult = Invoke-CdpHelper -Runtime $runtime -Arguments @("--probe")
                $url = Convert-ToCanonicalConversationUrl -Url ([string]$probeResult.probe.href)
                if (-not $url) { throw "Current page is not a ChatGPT conversation." }
                Set-WorkerConversationUrl -Runtime $runtime -Url $url
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "captured"; ConversationUrl = $url }
            }
            catch {
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "capture-failed"; ConversationUrl = $_.Exception.Message }
            }
        }
        $rows | Format-Table -AutoSize
    }
    "recover" {
        $runtime = Get-WorkerRuntime -Number $Worker
        Save-ControllerState -Runtimes @($runtime)
        $url = Get-WorkerConversationUrl -Runtime $runtime
        if (-not $url) { throw "No saved conversation URL for $($runtime.WorkerId). Run capture after a successful join first." }

        Stop-WorkerRuntime -Runtime $runtime
        Start-Sleep -Milliseconds 700
        $started = Start-WorkerRuntime -Runtime $runtime -Automation -ForceRestart
        $cleanup = Invoke-CdpHelper -Runtime $runtime -Arguments @("--dismiss-only", "--label", $runtime.Label, "--conversation-url", $url)
        $probe = $cleanup.afterDismiss
        $recoveryState = "restored-active"
        if ($probe.connectionInterrupted) {
            $null = Invoke-CdpHelper -Runtime $runtime -Arguments @("--interrupt-only", "--label", $runtime.Label, "--conversation-url", $url)
            Start-Sleep -Milliseconds 500
            $null = Invoke-CdpHelper -Runtime $runtime -Arguments @("--resume", "--label", $runtime.Label, "--conversation-url", $url)
            $recoveryState = "interrupted-resume-sent"
        }
        elseif (-not $probe.generating) {
            $null = Invoke-CdpHelper -Runtime $runtime -Arguments @("--resume", "--label", $runtime.Label, "--conversation-url", $url)
            $recoveryState = "resume-sent"
        }
        Start-Sleep -Milliseconds 500
        [void](Set-WorkerWindowState -Runtime $runtime -Mode minimize)
        [pscustomobject]@{
            Worker                = $runtime.WorkerId
            State                 = $recoveryState
            Pid                   = $started.Pid
            ConversationUrl       = $url
            WasGenerating         = [bool]$probe.generating
            ConnectionInterrupted = [bool]$probe.connectionInterrupted
        } | Format-List
    }
    "autojoin" {
        Save-ControllerState -Runtimes $runtimes
        $rows = for ($index = 0; $index -lt $runtimes.Count; $index++) {
            $runtime = $runtimes[$index]
            try {
                $null = Invoke-AutoJoin -Runtime $runtime
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "bootstrap-sent"; Detail = "ok" }
            }
            catch {
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "deferred"; Detail = $_.Exception.Message }
            }
            if ($StaggerSeconds -gt 0 -and $index -lt ($runtimes.Count - 1)) {
                Start-Sleep -Seconds $StaggerSeconds
            }
        }
        $rows | Format-Table -AutoSize
    }
    "help" {
        @"
Chat Swarm Classic Controller

  setup     Create/register missing worker runtime clones.
  start     Start workers; minimizes them by default.
  ensure    Make the saved worker pool healthy: start/reopen exact conversations, resume interrupted loops, minimize.
  status    Show runtime/login/automation health.
  minimize Minimize selected worker range.
  restore   Restore one worker window (-Worker N).
  stop      Stop only isolated worker runtimes; primary ChatGPT is untouched.
  repair    Restart one isolated worker without deleting its profile.
  capture   Persist each worker's current ChatGPT conversation URL for recovery.
  recover   Restart one worker, reopen its saved conversation, dismiss blockers, and resume only if needed.
  autojoin  Inject the current swarm join/bootstrap prompt via local CDP and save its conversation URL.

Automation example:
  .\chat-swarm-classic-controller.ps1 -Action start -Count 4 -EnableAutomation -RestartForAutomation
  .\chat-swarm-classic-controller.ps1 -Action autojoin -Count 4 -InviteCode ABCDEF123456
"@ | Write-Output
    }
}
