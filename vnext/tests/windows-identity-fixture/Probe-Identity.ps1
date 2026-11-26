param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][ValidateSet('agent','execution')][string]$Role,
    [Parameter(Mandatory=$true)][string]$ExpectedSid,
    [Parameter(Mandatory=$true)][string]$Report
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($identity.User.Value -ne $ExpectedSid -or $isAdmin -or @($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -ne 0) {
    throw 'Probe did not run as intended standard identity.'
}
$checks = [Collections.Generic.List[string]]::new()
function Expect-Denied([string]$Name, [scriptblock]$Operation, [switch]$AllowHiddenSource) {
    $denied = $false
    try { & $Operation | Out-Null }
    catch {
        $ex = $_.Exception
        while ($null -ne $ex) {
            if ($ex -is [UnauthorizedAccessException] -or ($ex -is [IO.IOException] -and ($ex.HResult -band 0xffff) -eq 5)) {
                $denied = $true
                break
            }
            # File.Move can report FILE_NOT_FOUND when its source is hidden by
            # ACLs. Only the move check permits this, with independent supervisor
            # verification of original sentinel and absent destination.
            if ($AllowHiddenSource -and $ex -is [IO.FileNotFoundException]) {
                $denied = $true
                break
            }
            $ex = $ex.InnerException
        }
        if (-not $denied) { throw }
    }
    if (-not $denied) { throw "Unexpected access success: $Name" }
    $checks.Add($Name)
}
function Check-Protected([string]$Name, [string]$Dir, [string]$Own) {
    $file = Join-Path $Dir 'sentinel.txt'
    Expect-Denied "$Name-read" { [IO.File]::ReadAllText($file) }
    Expect-Denied "$Name-write" { [IO.File]::WriteAllText($file, 'bad') }
    Expect-Denied "$Name-delete" { [IO.File]::Delete($file) }
    Expect-Denied "$Name-move" { [IO.File]::Move($file, (Join-Path $Own "$Name-stolen.txt")) } -AllowHiddenSource
    Expect-Denied "$Name-create" { [IO.File]::WriteAllText((Join-Path $Dir 'bad-new.txt'), 'bad') }
    Expect-Denied "$Name-acl" {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $identity.User, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
        [IO.Directory]::SetAccessControl($Dir, $acl)
    }
}
$own = if ($Role -eq 'execution') { Join-Path $Root 'workspace' } else { Join-Path $Root 'agent-private' }
$ownFile = Join-Path $own 'positive.txt'
[IO.File]::WriteAllText($ownFile, 'positive')
$checks.Add('own-write')
if ([IO.File]::ReadAllText($ownFile) -ne 'positive') { throw 'Approved workspace read failed.' }
$checks.Add('own-read')
if ($Role -eq 'execution') {
    Check-Protected 'agent' (Join-Path $Root 'agent-private') $own
    Check-Protected 'broker' (Join-Path $Root 'broker-private') $own
    Expect-Denied 'sibling-read' { [IO.File]::ReadAllText((Join-Path $Root 'sibling\sentinel.txt')) }
    Expect-Denied 'sibling-write' { [IO.File]::WriteAllText((Join-Path $Root 'sibling\sentinel.txt'), 'bad') }
} else {
    Check-Protected 'broker' (Join-Path $Root 'broker-private') $own
    Expect-Denied 'execution-read' { [IO.File]::ReadAllText((Join-Path $Root 'workspace\sentinel.txt')) }
    Expect-Denied 'execution-write' { [IO.File]::WriteAllText((Join-Path $Root 'workspace\sentinel.txt'), 'bad') }
}
Expect-Denied 'code-write' { [IO.File]::WriteAllText((Join-Path $Root 'code\sentinel.txt'), 'bad') }
Expect-Denied 'root-create' { [IO.File]::WriteAllText((Join-Path $Root 'bad-new.txt'), 'bad') }
[IO.File]::WriteAllText($Report, (@{sid=$identity.User.Value;admin=$isAdmin;role=$Role;checks=@($checks)} | ConvertTo-Json -Compress))
