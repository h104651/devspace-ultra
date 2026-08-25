[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [switch]$ForceRefresh,

    [switch]$Launch
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "chat-swarm-desktop-resolver.ps1")

function Save-Utf8Xml {
    param(
        [Parameter(Mandatory)] [xml]$Document,
        [Parameter(Mandatory)] [string]$Path
    )
    $settings = [System.Xml.XmlWriterSettings]::new()
    $settings.Encoding = [System.Text.UTF8Encoding]::new($false)
    $settings.Indent = $true
    $settings.NewLineChars = "`r`n"
    $settings.NewLineHandling = [System.Xml.NewLineHandling]::Replace
    $writer = [System.Xml.XmlWriter]::Create($Path, $settings)
    try { $Document.Save($writer) }
    finally { $writer.Dispose() }
}

function Remove-XmlNodes {
    param(
        [Parameter(Mandatory)] [xml]$Document,
        [Parameter(Mandatory)] [System.Xml.XmlNamespaceManager]$NamespaceManager,
        [Parameter(Mandatory)] [string]$XPath
    )
    $nodes = @($Document.SelectNodes($XPath, $NamespaceManager))
    foreach ($node in $nodes) {
        [void]$node.ParentNode.RemoveChild($node)
    }
}

$sourceInfo = Resolve-ChatGPTDesktopPackage -RequireInstalled
$sourceRoot = $sourceInfo.InstallLocation
$sourceVersion = [string]$sourceInfo.Version
$runtimeRoot = Join-Path $env:LOCALAPPDATA ("ChatGPT-Classic-Worker-Runtimes\" + $sourceVersion)
$results = @()

for ($offset = 0; $offset -lt $Count; $offset++) {
    $number = $FirstWorker + $offset
    $workerInfo = Resolve-ChatGPTDesktopPackage -WorkerNumber $number
    $workerId = $workerInfo.WorkerId
    $packageName = $workerInfo.PackageName
    $displayName = "ChatGPT Worker {0:D2}" -f $number
    $aliasName = $workerInfo.AliasName
    $cloneRoot = Join-Path $runtimeRoot $workerId
    $manifestPath = Join-Path $cloneRoot "AppxManifest.xml"

    $existingClone = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $needsCopy = $ForceRefresh -or -not (Test-Path -LiteralPath $manifestPath)
    if ($needsCopy) {
        if (Test-Path -LiteralPath $cloneRoot) {
            Remove-Item -LiteralPath $cloneRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $cloneRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceRoot "*") -Destination $cloneRoot -Recurse -Force

        # A registered loose-file development package should not retain the
        # Store package's signature/block-map/integrity catalogue after its
        # manifest identity has been changed.
        foreach ($artifact in @("AppxSignature.p7x", "AppxBlockMap.xml")) {
            $artifactPath = Join-Path $cloneRoot $artifact
            if (Test-Path -LiteralPath $artifactPath) {
                Remove-Item -LiteralPath $artifactPath -Force
            }
        }
        $metadataPath = Join-Path $cloneRoot "AppxMetadata"
        if (Test-Path -LiteralPath $metadataPath) {
            Remove-Item -LiteralPath $metadataPath -Recurse -Force
        }

        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
        $ns = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
        $ns.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
        $ns.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
        $ns.AddNamespace("uap3", "http://schemas.microsoft.com/appx/manifest/uap/windows10/3")
        $ns.AddNamespace("uap5", "http://schemas.microsoft.com/appx/manifest/uap/windows10/5")
        $ns.AddNamespace("uap10", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
        $ns.AddNamespace("desktop", "http://schemas.microsoft.com/appx/manifest/desktop/windows10")

        $identity = $manifest.SelectSingleNode("/f:Package/f:Identity", $ns)
        if (-not $identity) { throw "Clone manifest is missing Package/Identity." }
        $identity.SetAttribute("Name", $packageName)

        $propertyDisplayName = $manifest.SelectSingleNode("/f:Package/f:Properties/f:DisplayName", $ns)
        if ($propertyDisplayName) { $propertyDisplayName.InnerText = $displayName }
        $propertyDescription = $manifest.SelectSingleNode("/f:Package/f:Properties/f:Description", $ns)
        if ($propertyDescription) { $propertyDescription.InnerText = "$displayName runtime clone" }

        $visual = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements", $ns)
        if ($visual) {
            $visual.SetAttribute("DisplayName", $displayName)
            $visual.SetAttribute("Description", "$displayName runtime clone")
        }

        $defaultTile = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements/uap:DefaultTile", $ns)
        if ($defaultTile) { $defaultTile.SetAttribute("ShortName", $displayName) }

        # Check or inject windows.appExecutionAlias
        $executionAlias = $manifest.SelectSingleNode("//uap3:Extension[@Category='windows.appExecutionAlias']//desktop:ExecutionAlias", $ns)
        if ($executionAlias) {
            $executionAlias.SetAttribute("Alias", $aliasName)
        } else {
            # Inject execution alias into Application/Extensions
            $appNode = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $ns)
            if (-not $appNode) { throw "Clone manifest is missing Application node." }
            
            $extensionsNode = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/f:Extensions", $ns)
            if (-not $extensionsNode) {
                $extensionsNode = $manifest.CreateElement("Extensions", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
                [void]$appNode.AppendChild($extensionsNode)
            }

            $uap3Ns = "http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
            $desktopNs = "http://schemas.microsoft.com/appx/manifest/desktop/windows10"

            $extElement = $manifest.CreateElement("uap3", "Extension", $uap3Ns)
            $extElement.SetAttribute("Category", "windows.appExecutionAlias")
            $extElement.SetAttribute("Executable", $sourceInfo.ExecutableRelative)
            $extElement.SetAttribute("EntryPoint", "Windows.FullTrustApplication")

            $appAliasElement = $manifest.CreateElement("uap3", "AppExecutionAlias", $uap3Ns)
            $desktopAliasElement = $manifest.CreateElement("desktop", "ExecutionAlias", $desktopNs)
            $desktopAliasElement.SetAttribute("Alias", $aliasName)

            [void]$appAliasElement.AppendChild($desktopAliasElement)
            [void]$extElement.AppendChild($appAliasElement)
            [void]$extensionsNode.AppendChild($extElement)
        }

        # Worker clones must not compete with the primary ChatGPT installation
        # for chatgpt:// links, Windows startup, or Copilot-key app extension.
        Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap:Extension[@Category='windows.protocol']"
        Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap5:Extension[@Category='windows.startupTask']"
        Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap3:Extension[@Category='windows.appExtension']"
        Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "/f:Package/f:Properties/uap10:PackageIntegrity"

        Save-Utf8Xml -Document $manifest -Path $manifestPath
    }

    if ($existingClone) {
        Remove-AppxPackage -Package $existingClone.PackageFullName -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    }

    Add-AppxPackage -Register $manifestPath -ErrorAction Stop
    $registered = Get-AppxPackage -Name $packageName -ErrorAction Stop |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $launchResult = "not-requested"
    if ($Launch) {
        $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)
        if (-not (Test-Path -LiteralPath $aliasPath)) {
            throw "Worker alias was not registered: $aliasPath"
        }
        Start-Process -FilePath $aliasPath | Out-Null
        $launchResult = "started"
    }

    $results += [pscustomobject]@{
        WorkerId = $workerId
        PackageName = $packageName
        PackageFullName = $registered.PackageFullName
        InstallLocation = $registered.InstallLocation
        Alias = $aliasName
        Launch = $launchResult
    }
}

$results | Format-Table WorkerId, PackageName, Alias, Launch -AutoSize
