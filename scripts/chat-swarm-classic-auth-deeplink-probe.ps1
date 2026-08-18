[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web

$chrome = Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if (-not $chrome) { throw "No Chrome main window found." }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
$all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
)

$url = $null
foreach ($element in $all) {
    if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { continue }
    try {
        $value = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
    }
    catch {
        $value = ""
    }
    if ($value -match "chatgpt\.com/auth/open_in_desktop") {
        $url = $value
        break
    }
}

if (-not $url) { throw "ChatGPT auth open_in_desktop URL was not found in Chrome." }
if ($url -notmatch "^https?://") { $url = "https://$url" }

$response = Invoke-WebRequest -Uri $url -UseBasicParsing
$content = [System.Web.HttpUtility]::HtmlDecode($response.Content)

$patterns = @(
    'chatgpt://[^"''<>\s]+',
    'chatgpt:\\/\\/[^"''<>\s]+'
)

$target = $null
foreach ($pattern in $patterns) {
    $match = [regex]::Match($content, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) {
        $target = $match.Value -replace '\\/', '/'
        break
    }
}

if (-not $target) {
    $decoded = [System.Uri]::UnescapeDataString($content)
    foreach ($pattern in $patterns) {
        $match = [regex]::Match($decoded, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) {
            $target = $match.Value -replace '\\/', '/'
            break
        }
    }
}

if (-not $target) {
    [pscustomobject]@{
        Found = $false
        HttpStatus = $response.StatusCode
        ResponseBytes = $response.RawContentLength
    } | Format-List
    exit 2
}

$uri = [uri]$target
[pscustomobject]@{
    Found = $true
    Scheme = $uri.Scheme
    Host = $uri.Host
    Path = $uri.AbsolutePath
    HasQuery = [bool]$uri.Query
} | Format-List
