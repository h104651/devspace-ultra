$ErrorActionPreference = "Stop"

Write-Host "DevSpace Ultra installer" -ForegroundColor Cyan

function Require-Command {
    param([Parameter(Mandatory)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "$Name is required. Install Node.js 22.19 or newer (but lower than 27), then run this installer again."
    }
    $command
}

$node = Require-Command -Name "node"
$npm = Require-Command -Name "npm"

$versionText = (& $node.Source --version).Trim().TrimStart('v')
$parts = $versionText.Split('.')
$major = [int]$parts[0]
$minor = if ($parts.Length -gt 1) { [int]$parts[1] } else { 0 }
if ($major -lt 22 -or $major -ge 27 -or ($major -eq 22 -and $minor -lt 19)) {
    throw "Unsupported Node.js $versionText. DevSpace Ultra requires Node.js >=22.19 and <27."
}

Write-Host "Node.js $versionText detected." -ForegroundColor Green
Write-Host "Installing DevSpace Ultra from GitHub..." -ForegroundColor Cyan
& $npm.Source install -g "github:enwong93-sketch/devspace-ultra#main"
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }

$ultra = Get-Command "devspace-ultra" -ErrorAction SilentlyContinue
if (-not $ultra) { throw "Installation completed but devspace-ultra is not on PATH. Restart the terminal and try again." }

Write-Host "DevSpace Ultra installed successfully." -ForegroundColor Green

if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $chatgpt = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($chatgpt) {
        Write-Host "ChatGPT Classic package $($chatgpt.Version) detected. Windows autonomous worker runtimes can be provisioned after DevSpace setup." -ForegroundColor Green
    }
    else {
        Write-Host "ChatGPT Classic Microsoft Store package was not detected. Base DevSpace and Chat Swarm still work, but Windows autonomous desktop runtime cloning needs that package." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  devspace-ultra init"
Write-Host "  devspace-ultra serve"
Write-Host ""
Write-Host "The compatibility alias 'devspace' is also installed."
