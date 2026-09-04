[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [ValidateRange(3, 60)]
    [int]$VerifyTimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "chat-swarm-desktop-resolver.ps1")

$results = @()

for ($offset = 0; $offset -lt $Count; $offset++) {
    $number = $FirstWorker + $offset
    $workerInfo = Resolve-ChatGPTDesktopPackage -WorkerNumber $number
    $workerId = $workerInfo.WorkerId
    $packageName = $workerInfo.PackageName
    $aliasName = $workerInfo.AliasName
    $aliasPath = $workerInfo.AliasPath

    if (-not $workerInfo.Registered) {
        throw "$workerId runtime clone is not registered. Run chat-swarm-classic-runtime-clone.ps1 for this worker first."
    }
    if (-not (Test-Path -LiteralPath $aliasPath)) {
        throw "$workerId execution alias is missing: $aliasPath"
    }

    $runtimeExe = $workerInfo.ExecutablePath
    $processName = $workerInfo.ProcessName

    $before = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq $processName -and
                $_.ExecutablePath -eq $runtimeExe -and
                $_.CommandLine -notlike "*--type=*"
            } |
            Select-Object -ExpandProperty ProcessId
    )

    if ($before.Count -gt 0) {
        $results += [pscustomobject]@{
            WorkerId    = $workerId
            PackageName = $packageName
            State       = "already-running"
            RootPid     = ($before -join ",")
            WindowTitle = ((Get-Process -Id $before[0] -ErrorAction SilentlyContinue).MainWindowTitle)
        }
        continue
    }

    Start-Process -FilePath $aliasPath | Out-Null
    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
    $root = @()
    do {
        Start-Sleep -Milliseconds 500
        $root = @(
            Get-CimInstance Win32_Process |
                Where-Object {
                    $_.Name -eq $processName -and
                    $_.ExecutablePath -eq $runtimeExe -and
                    $_.CommandLine -notlike "*--type=*"
                }
        )
    } while ($root.Count -eq 0 -and (Get-Date) -lt $deadline)

    if ($root.Count -eq 0) {
        throw "$workerId was launched but no independent $processName root process appeared before timeout."
    }

    $rootPid = $root[0].ProcessId
    $process = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
    $results += [pscustomobject]@{
        WorkerId    = $workerId
        PackageName = $packageName
        State       = "running"
        RootPid     = $rootPid
        WindowTitle = $process.MainWindowTitle
    }
}

$results | Format-Table -AutoSize
