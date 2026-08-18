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

$runtimeCloneScript = Join-Path $PSScriptRoot "chat-swarm-classic-runtime-clone.ps1"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$stateRoot = Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic"
$statePath = Join-Path $stateRoot "controller-state.json"
$authSeedRoot = Join-Path $stateRoot "auth-seed"
$authSeedProfile = Join-Path $authSeedRoot "profile"
$authStateItems = @(
    "Local State",
    "Preferences",
    "config.json",
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

    $suffix = "Worker{0:D2}" -f $Number
    $packageName = "OpenAI.ChatGPT-Desktop.$suffix"
    $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $aliasName = "chatgpt-classic-worker{0:D2}.exe" -f $Number
    $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)

    if (-not $package) {
        return [pscustomobject]@{
            Number = $Number
            WorkerId = "worker-{0:D2}" -f $Number
            Label = "Runtime-{0:D2}" -f $Number
            PackageName = $packageName
            PackageFamilyName = $null
            InstallLocation = $null
            ExecutablePath = $null
            AliasPath = $aliasPath
            ProfilePath = $null
            DebugPort = $DebugBasePort + $Number
            Registered = $false
        }
    }

    [pscustomobject]@{
        Number = $Number
        WorkerId = "worker-{0:D2}" -f $Number
        Label = "Runtime-{0:D2}" -f $Number
        PackageName = $packageName
        PackageFamilyName = $package.PackageFamilyName
        InstallLocation = $package.InstallLocation
        ExecutablePath = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
        AliasPath = $aliasPath
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        DebugPort = $DebugBasePort + $Number
        Registered = $true
    }
}

function Get-WorkerRootProcess {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) { return $null }

    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
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

    # Merge instead of replacing so starting/recovering one worker does not
    # erase mappings for the rest of the production pool.
    $byNumber = @{}
    $existing = Read-ControllerState
    if ($existing) {
        foreach ($item in @($existing.workers)) {
            if ($null -eq $item.number) { continue }
            $byNumber[[int]$item.number] = [ordered]@{
                number = [int]$item.number
                workerId = [string]$item.workerId
                label = [string]$item.label
                packageName = [string]$item.packageName
                packageFamilyName = [string]$item.packageFamilyName
                profilePath = [string]$item.profilePath
                debugPort = [int]$item.debugPort
                conversationUrl = if ($item.PSObject.Properties.Name -contains "conversationUrl") { [string]$item.conversationUrl } else { $null }
            }
        }
    }

    foreach ($runtime in $Runtimes) {
        $prior = $byNumber[[int]$runtime.Number]
        $conversationUrl = if ($prior) { $prior.conversationUrl } else { $null }
        $byNumber[[int]$runtime.Number] = [ordered]@{
            number = $runtime.Number
            workerId = $runtime.WorkerId
            label = $runtime.Label
            packageName = $runtime.PackageName
            packageFamilyName = $runtime.PackageFamilyName
            profilePath = $runtime.ProfilePath
            debugPort = $runtime.DebugPort
            conversationUrl = $conversationUrl
        }
    }

    $existingProjectUrl = if ($existing -and $existing.PSObject.Properties.Name -contains "projectUrl") { [string]$existing.projectUrl } else { $null }
    $effectiveProjectUrl = if (-not [string]::IsNullOrWhiteSpace($ProjectUrl)) { $ProjectUrl.Trim() } else { $existingProjectUrl }
    if (-not [string]::IsNullOrWhiteSpace($effectiveProjectUrl) -and $effectiveProjectUrl -notmatch '^https://chatgpt\.com/g/g-p-[^/]+/project/?$') {
        throw "ProjectUrl must be a ChatGPT project URL like https://chatgpt.com/g/g-p-.../project"
    }

    $existingDesired = if ($existing -and $existing.PSObject.Properties.Name -contains "productionDesired") { [int]$existing.productionDesired } else { 4 }
    $payload = [ordered]@{
        version = 4
        updatedAt = (Get-Date).ToString("o")
        debugBasePort = $DebugBasePort
        projectUrl = $effectiveProjectUrl
        reservedWorkers = @(Get-ReservedWorkerNumbers)
        productionDesired = $existingDesired
        workers = @($byNumber.Keys | Sort-Object | ForEach-Object { $byNumber[$_] })
    }
    $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Set-WorkerConversationUrl {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$Url
    )
    if ($Url -notmatch '^https://chatgpt\.com/(?:c/|g/g-p-[^/]+/c/)') {
        throw "Refusing to store non-conversation URL for $($Runtime.WorkerId): $Url"
    }
    $state = Read-ControllerState
    if (-not $state) { throw "Controller state is missing; run start/status setup first." }
    $entry = @($state.workers | Where-Object { [int]$_.number -eq [int]$Runtime.Number } | Select-Object -First 1)
    if ($entry.Count -eq 0) { throw "No controller state entry for $($Runtime.WorkerId)." }
    $worker = $entry[0]
    $worker | Add-Member -NotePropertyName conversationUrl -NotePropertyValue $Url -Force
    $state.updatedAt = (Get-Date).ToString("o")
    $state.version = 4
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Set-ProductionDesired {
    param([Parameter(Mandatory)][int]$Desired)
    $state = Read-ControllerState
    if (-not $state) { throw "Controller state is missing." }
    $state | Add-Member -NotePropertyName productionDesired -NotePropertyValue $Desired -Force
    $state | Add-Member -NotePropertyName reservedWorkers -NotePropertyValue @(Get-ReservedWorkerNumbers) -Force
    $state.updatedAt = (Get-Date).ToString("o")
    $state.version = 4
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Get-ConfiguredProjectUrl {
    if (-not [string]::IsNullOrWhiteSpace($ProjectUrl)) {
        $candidate = $ProjectUrl.Trim()
        if ($candidate -notmatch '^https://chatgpt\.com/g/g-p-[^/]+/project/?$') {
            throw "ProjectUrl must be a ChatGPT project URL like https://chatgpt.com/g/g-p-.../project"
        }
        return $candidate.TrimEnd('/')
    }
    $state = Read-ControllerState
    if ($state -and $state.PSObject.Properties.Name -contains "projectUrl") {
        $saved = [string]$state.projectUrl
        if (-not [string]::IsNullOrWhiteSpace($saved)) { return $saved.TrimEnd('/') }
    }
    return $null
}

function Get-WorkerConversationUrl {
    param([Parameter(Mandatory)]$Runtime)
    $state = Read-ControllerState
    if (-not $state) { return $null }
    $entry = @($state.workers | Where-Object { [int]$_.number -eq [int]$Runtime.Number } | Select-Object -First 1)
    if ($entry.Count -eq 0) { return $null }
    $url = [string]$entry[0].conversationUrl
    if ([string]::IsNullOrWhiteSpace($url)) { return $null }
    return $url
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
        WorkerId = $Runtime.WorkerId
        Pid = $root.ProcessId
        Responding = [bool]$process.Responding
        DebugPort = $Runtime.DebugPort
        Automation = (Test-TcpPort -Port $Runtime.DebugPort)
        WindowHandle = [long]$process.MainWindowHandle
        WindowTitle = $process.MainWindowTitle
    }
}

function Stop-WorkerRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) { return }

    $processes = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq "ChatGPT Classic.exe" -and
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
        [ValidateSet("minimize", "restore")][string]$Mode
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
    $profile = $Runtime.ProfilePath

    [pscustomobject]@{
        Worker = $Runtime.WorkerId
        Registered = $Runtime.Registered
        Running = [bool]$root
        Pid = if ($root) { $root.ProcessId } else { $null }
        Responding = if ($process) { [bool]$process.Responding } else { $false }
        LoggedInState = if ($profile) { Test-Path -LiteralPath (Join-Path $profile "IndexedDB") } else { $false }
        Automation = Test-TcpPort -Port $Runtime.DebugPort
        DebugPort = $Runtime.DebugPort
        WindowTitle = if ($process) { $process.MainWindowTitle } else { "" }
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
}

function Test-AuthProfile {
    param([string]$ProfilePath)
    if ([string]::IsNullOrWhiteSpace($ProfilePath)) { return $false }
    Test-Path -LiteralPath (Join-Path $ProfilePath "IndexedDB")
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
    if (-not $sourceRuntime) {
        throw "No authenticated production worker is available to seed new runtimes. Provision/login one worker first."
    }

    $wasRunning = [bool](Get-WorkerRootProcess -Runtime $sourceRuntime)
    if ($wasRunning) {
        Stop-WorkerRuntime -Runtime $sourceRuntime
        Start-Sleep -Milliseconds 900
    }
    if (Test-Path -LiteralPath $authSeedProfile) { Remove-Item -LiteralPath $authSeedProfile -Recurse -Force }
    New-Item -ItemType Directory -Path $authSeedProfile -Force | Out-Null
    foreach ($item in $authStateItems) {
        Copy-AuthStateItem -SourceRoot $sourceRuntime.ProfilePath -TargetRoot $authSeedProfile -RelativePath $item
    }
    if (-not (Test-AuthProfile -ProfilePath $authSeedProfile)) {
        throw "Authentication seed capture failed: IndexedDB is missing from the seed."
    }
    return "captured-from-$($sourceRuntime.WorkerId)"
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
    $url = Get-WorkerConversationUrl -Runtime $Runtime
    $root = Get-WorkerRootProcess -Runtime $Runtime
    $automation = Test-TcpPort -Port $Runtime.DebugPort
    $state = "healthy"
    $probe = $null

    if (-not $root -or -not $automation) {
        if ($root) { Stop-WorkerRuntime -Runtime $Runtime; Start-Sleep -Milliseconds 500 }
        $null = Start-WorkerRuntime -Runtime $Runtime -Automation -ForceRestart
        $state = "started"
    }

    if ($url) {
        $probeResult = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--probe", "--compact")
        $currentUrl = Convert-ToCanonicalConversationUrl -Url ([string]$probeResult.probe.href)
        if ($currentUrl -ne $url) {
            $cleanup = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--dismiss-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $probe = $cleanup.afterDismiss
            $state = if ($state -eq "started") { "started-restored" } else { "restored" }
        }
        else {
            $cleanup = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--dismiss-only", "--compact", "--label", $Runtime.Label)
            $probe = $cleanup.afterDismiss
        }
        if ($probe.connectionInterrupted) {
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--interrupt-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            Start-Sleep -Milliseconds 350
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--resume", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $state = "interrupted-resume-sent"
        }
        elseif (-not $probe.generating) {
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--resume", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $state = if ($state -eq "healthy") { "resume-sent" } else { "$state-resume-sent" }
        }
    }
    elseif (-not $root -or -not $automation) {
        $state = "started-no-conversation-map"
    }
    else {
        $state = "running-no-conversation-map"
    }

    Start-Sleep -Milliseconds 250
    [void](Set-WorkerWindowState -Runtime $Runtime -Mode minimize)
    $status = Get-WorkerStatusRow -Runtime $Runtime
    [pscustomobject]@{
        Worker = $Runtime.WorkerId
        Label = $Runtime.Label
        State = $state
        Running = $status.Running
        Responding = $status.Responding
        LoggedIn = $status.LoggedInState
        Automation = $status.Automation
        ConversationUrl = $url
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
    $node = (Get-Command node -ErrorAction Stop).Source
    $commandArguments = @($bootstrapScript, "--port", [string]$Runtime.DebugPort, "--compact") + $Arguments
    $output = @(& $node @commandArguments)
    if ($LASTEXITCODE -ne 0) {
        throw "CDP helper failed for $($Runtime.WorkerId) with exit code $LASTEXITCODE."
    }
    $text = ($output -join "`n").Trim()
    try { return ($text | ConvertFrom-Json) }
    catch { throw "CDP helper returned invalid JSON for $($Runtime.WorkerId): $text" }
}

function Convert-ToCanonicalConversationUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url) -or $Url -notmatch '^https://chatgpt\.com/(?:c/|g/g-p-[^/]+/c/)') { return $null }
    $uri = [Uri]$Url
    return "$($uri.Scheme)://$($uri.Host)$($uri.AbsolutePath)"
}

function Invoke-AutoJoin {
    param([Parameter(Mandatory)]$Runtime)

    if ([string]::IsNullOrWhiteSpace($InviteCode)) {
        throw "autojoin requires -InviteCode."
    }
    $arguments = @("--invite", $InviteCode, "--label", $Runtime.Label, "--minimal")
    $existingConversationUrl = Get-WorkerConversationUrl -Runtime $Runtime
    if ($existingConversationUrl) {
        $arguments += @("--conversation-url", $existingConversationUrl)
    }
    else {
        $targetProjectUrl = Get-ConfiguredProjectUrl
        if ($targetProjectUrl) { $arguments += @("--project-url", $targetProjectUrl) }
    }
    $result = Invoke-CdpHelper -Runtime $Runtime -Arguments $arguments
    $url = Convert-ToCanonicalConversationUrl -Url ([string]$result.after.href)
    if ($url) { Set-WorkerConversationUrl -Runtime $Runtime -Url $url }
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
                    Worker = $runtime.WorkerId
                    Label = $runtime.Label
                    State = "scaled-down-stopped"
                    Running = $false
                    Responding = $false
                    LoggedIn = (Test-AuthProfile -ProfilePath $runtime.ProfilePath)
                    Automation = $false
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
            Worker = $runtime.WorkerId
            State = $recoveryState
            Pid = $started.Pid
            ConversationUrl = $url
            WasGenerating = [bool]$probe.generating
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
