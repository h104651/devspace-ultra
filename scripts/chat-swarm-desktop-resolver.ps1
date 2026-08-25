# Centralized desktop package resolver abstraction supporting both modern
# OpenAI.Codex (ARM64/x64) and legacy OpenAI.ChatGPT-Desktop (Classic).

function Resolve-ChatGPTDesktopPackage {
    [CmdletBinding()]
    param(
        [string]$PreferredPackageName,
        [int]$WorkerNumber,
        [switch]$RequireInstalled
    )

    $primaryNames = @("OpenAI.Codex", "OpenAI.ChatGPT-Desktop")
    if ($PreferredPackageName -and -not ($PreferredPackageName -match '\.Worker\d+')) {
        $primaryNames = @($PreferredPackageName) + ($primaryNames | Where-Object { $_ -ne $PreferredPackageName })
    }

    $primaryPackage = $null
    foreach ($name in $primaryNames) {
        $primaryPackage = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue |
            Sort-Object Version -Descending |
            Select-Object -First 1
        if ($primaryPackage) { break }
    }

    if (-not $primaryPackage -and $RequireInstalled) {
        throw "Neither OpenAI.Codex nor OpenAI.ChatGPT-Desktop package is installed for the current user."
    }

    $primaryBaseName = if ($primaryPackage) { [string]$primaryPackage.Name } elseif ($PreferredPackageName) { ($PreferredPackageName -replace '\.Worker\d+.*$', '') } else { "OpenAI.Codex" }
    $isCodex = ($primaryBaseName -eq "OpenAI.Codex")

    $primaryVersion = if ($primaryPackage) { [string]$primaryPackage.Version } else { $null }
    $primaryInstallLocation = if ($primaryPackage) { [string]$primaryPackage.InstallLocation } else { $null }
    $primaryArchitecture = if ($primaryPackage) { [string]$primaryPackage.Architecture } else { $null }
    $primaryFamilyName = if ($primaryPackage) { [string]$primaryPackage.PackageFamilyName } else { $null }

    $execRel = if ($isCodex) { "app\ChatGPT.exe" } else { "app\ChatGPT Classic.exe" }
    $procName = if ($isCodex) { "ChatGPT.exe" } else { "ChatGPT Classic.exe" }
    $profileRel = if ($isCodex) { "LocalCache\Roaming\Codex\web\Codex" } else { "LocalCache\Roaming\ChatGPT" }
    $runtimeKind = if ($isCodex) { "Codex" } else { "Classic" }

    if (-not $PSBoundParameters.ContainsKey("WorkerNumber")) {
        return [pscustomobject]@{
            PackageName           = $primaryBaseName
            PackageFullName       = if ($primaryPackage) { [string]$primaryPackage.PackageFullName } else { $null }
            PackageFamilyName     = $primaryFamilyName
            Version               = $primaryVersion
            Architecture          = $primaryArchitecture
            InstallLocation       = $primaryInstallLocation
            ExecutableRelative    = $execRel
            ExecutablePath        = if ($primaryInstallLocation) { Join-Path $primaryInstallLocation $execRel } else { $null }
            ProcessName           = $procName
            ApplicationId         = "App"
            AppUserModelId        = if ($primaryFamilyName) { "$($primaryFamilyName)!App" } else { $null }
            ProfileRelativePath   = $profileRel
            ProfilePath           = if ($primaryFamilyName) { Join-Path $env:LOCALAPPDATA ("Packages\{0}\{1}" -f $primaryFamilyName, $profileRel) } else { $null }
            NeedsAliasInjection   = $isCodex
            RuntimeKind           = $runtimeKind
            IsInstalled           = [bool]$primaryPackage
        }
    }

    # Worker clone resolution
    $suffix = "Worker{0:D2}" -f $WorkerNumber
    $workerPackageName = "$($primaryBaseName).$($suffix)"
    $workerAliasName = if ($isCodex) { "chatgpt-worker{0:D2}.exe" -f $WorkerNumber } else { "chatgpt-classic-worker{0:D2}.exe" -f $WorkerNumber }
    $workerAliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $workerAliasName)
    $workerProfileRel = if ($isCodex) { "LocalCache\Roaming\Codex\web\" + ($workerAliasName -replace '\.exe$', '') } else { "LocalCache\Roaming\ChatGPT" }

    $workerPackage = Get-AppxPackage -Name $workerPackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $workerFamilyName = if ($workerPackage) { [string]$workerPackage.PackageFamilyName } else { $null }
    $workerInstallLocation = if ($workerPackage) { [string]$workerPackage.InstallLocation } else { $null }

    return [pscustomobject]@{
        WorkerNumber          = $WorkerNumber
        WorkerId              = "worker-{0:D2}" -f $WorkerNumber
        Label                 = "Runtime-{0:D2}" -f $WorkerNumber
        PrimaryBaseName       = $primaryBaseName
        PackageName           = $workerPackageName
        PackageFullName       = if ($workerPackage) { [string]$workerPackage.PackageFullName } else { $null }
        PackageFamilyName     = $workerFamilyName
        Version               = if ($workerPackage) { [string]$workerPackage.Version } else { $primaryVersion }
        Architecture          = if ($workerPackage) { [string]$workerPackage.Architecture } else { $primaryArchitecture }
        InstallLocation       = $workerInstallLocation
        ExecutableRelative    = $execRel
        ExecutablePath        = if ($workerInstallLocation) { Join-Path $workerInstallLocation $execRel } else { $null }
        ProcessName           = $procName
        ApplicationId         = "App"
        AppUserModelId        = if ($workerFamilyName) { "$($workerFamilyName)!App" } else { $null }
        AliasName             = $workerAliasName
        AliasPath             = $workerAliasPath
        ProfileRelativePath   = $workerProfileRel
        ProfilePath           = if ($workerFamilyName) { Join-Path $env:LOCALAPPDATA ("Packages\{0}\{1}" -f $workerFamilyName, $workerProfileRel) } else { $null }
        NeedsAliasInjection   = $isCodex
        RuntimeKind           = $runtimeKind
        Registered            = [bool]$workerPackage
    }
}
