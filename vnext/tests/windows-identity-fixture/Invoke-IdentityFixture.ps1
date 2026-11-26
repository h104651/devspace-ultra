# Synthetic fixture: never run on a workstation or a self-hosted runner.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Identity fixture is restricted to disposable GitHub-hosted runners.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Fixture requires an elevated disposable runner; no fallback.'
}
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$root = Join-Path $env:ProgramData "dsu-ci-identity-$tag"
$created = [Collections.Generic.List[object]]::new()
$active = [Collections.Generic.List[Diagnostics.Process]]::new()
$secrets = [Collections.Generic.List[Security.SecureString]]::new()
$cleanupFailed = $false
$rootCreated = $false

function New-FixtureAccount([string]$Name) {
    # Random disposable password: never written to disk or a command line/log.
    $secret = ConvertTo-SecureString ('Aa9!' + [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $secrets.Add($secret)
    $account = New-LocalUser -Name $Name -Password $secret -Description 'Disposable DevSpace CI fixture' -AccountNeverExpires
    $created.Add($account)
    $members = @(Get-LocalGroupMember -SID $usersSid)
    if (-not ($members | Where-Object { $_.SID.Value -eq $account.SID.Value })) {
        # -Member expects a LocalPrincipal, not a SecurityIdentifier instance.
        Add-LocalGroupMember -SID $usersSid -Member $account
        if (-not (Get-LocalGroupMember -SID $usersSid | Where-Object { $_.SID.Value -eq $account.SID.Value })) {
            throw 'Fixture Users group membership not established.'
        }
    }
    $credential = [Management.Automation.PSCredential]::new(".\$Name", $secret)
    return [pscustomobject]@{ Sid = $account.SID; Credential = $credential }
}
function Set-FixtureDirectoryAcl([string]$Path, [object[]]$Grants, [bool]$Inherit) {
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($adminSid)
    $inheritFlags = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $none = [Security.AccessControl.PropagationFlags]::None
    foreach ($sid in @($adminSid, $systemSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritFlags, $none, $allow))
    }
    foreach ($grant in $Grants) {
        $flags = if ($Inherit) { $inheritFlags } else { [Security.AccessControl.InheritanceFlags]::None }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $grant.Sid, [Security.AccessControl.FileSystemRights]$grant.Rights, $flags, $none, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $adminSid.Value) {
        throw 'Fixture ACL ownership/protection failed.'
    }
    if ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Fixture directory must not be a reparse point.'
    }
}
function Invoke-FixtureProbe($Account, [string]$Role, [string]$Work) {
    $probe = Join-Path $code 'Probe-Identity.ps1'
    $report = Join-Path $Work 'report.json'
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Locally generated paths only; no credential or password on argv.
    $argv = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        ('"' + $probe + '"'), '-Root', ('"' + $root + '"'), '-Role', $Role,
        '-ExpectedSid', $Account.Sid.Value, '-Report', ('"' + $report + '"'))
    $startArgs = @{
        FilePath = $exe
        Credential = $Account.Credential
        ArgumentList = $argv
        WorkingDirectory = $Work
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    $proc = Start-Process @startArgs
    $active.Add($proc)
    if (-not $proc.WaitForExit(45000)) {
        # Only the exact process this fixture created; the probe has no children.
        $proc.Kill()
        if (-not $proc.WaitForExit(5000)) { throw 'Fixture probe exit is unverified.' }
        throw 'Fixture probe timed out.'
    }
    if ($proc.ExitCode -ne 0 -or -not [IO.File]::Exists($report)) {
        throw "Fixture $Role probe did not produce a successful report (exit $($proc.ExitCode))."
    }
    $result = [IO.File]::ReadAllText($report) | ConvertFrom-Json
    if ($result.sid -ne $Account.Sid.Value -or $result.admin -ne $false -or $result.role -ne $Role) {
        throw 'Probe identity mismatch.'
    }
    $expected = if ($Role -eq 'execution') {
        @('own-write','own-read','agent-read','agent-write','agent-delete','agent-move',
          'agent-create','agent-acl','broker-read','broker-write','broker-delete','broker-move',
          'broker-create','broker-acl','sibling-read','sibling-write','code-write','root-create')
    } else {
        @('own-write','own-read','broker-read','broker-write','broker-delete','broker-move',
          'broker-create','broker-acl','execution-read','execution-write','code-write','root-create')
    }
    if (Compare-Object -ReferenceObject @($expected | Sort-Object) -DifferenceObject @($result.checks | Sort-Object)) {
        throw "Missing or extra fixture checks for $Role."
    }
    Write-Host "IDENTITY_FIXTURE $Role PASS ($($expected.Count) checks; actual standard-user SID)"
}
try {
    if ([IO.Directory]::Exists($root)) { throw 'Random fixture path already exists.' }
    $agent = New-FixtureAccount "dsua_$tag"
    $execution = New-FixtureAccount "dsue_$tag"
    if ($agent.Sid.Value -eq $execution.Sid.Value -or $agent.Sid.Value -eq $identity.User.Value -or $execution.Sid.Value -eq $identity.User.Value) {
        throw 'Fixture identities must be distinct.'
    }
    $rxA = @{Sid=$agent.Sid; Rights='ReadAndExecute'}
    $rxE = @{Sid=$execution.Sid; Rights='ReadAndExecute'}
    $modA = @{Sid=$agent.Sid; Rights='Modify'}
    $modE = @{Sid=$execution.Sid; Rights='Modify'}
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $rootCreated = $true
    Set-FixtureDirectoryAcl $root @($rxA, $rxE) $false
    $code = Join-Path $root 'code'
    $agentPrivate = Join-Path $root 'agent-private'
    $brokerPrivate = Join-Path $root 'broker-private'
    $workspace = Join-Path $root 'workspace'
    $sibling = Join-Path $root 'sibling'
    Set-FixtureDirectoryAcl $code @($rxA, $rxE) $true
    Set-FixtureDirectoryAcl $agentPrivate @($modA) $true
    Set-FixtureDirectoryAcl $brokerPrivate @() $false
    Set-FixtureDirectoryAcl $workspace @($modE) $true
    Set-FixtureDirectoryAcl $sibling @() $false
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Probe-Identity.ps1') -Destination (Join-Path $code 'Probe-Identity.ps1')
    foreach ($dir in @($agentPrivate, $brokerPrivate, $workspace, $sibling, $code)) {
        [IO.File]::WriteAllText((Join-Path $dir 'sentinel.txt'), 'synthetic-only')
    }
    Invoke-FixtureProbe $execution 'execution' $workspace
    Invoke-FixtureProbe $agent 'agent' $agentPrivate
    foreach ($dir in @($agentPrivate, $brokerPrivate, $workspace, $sibling, $code)) {
        if ([IO.File]::ReadAllText((Join-Path $dir 'sentinel.txt')) -ne 'synthetic-only') {
            throw 'Protected sentinel changed.'
        }
    }
    Write-Host 'CROSS_IDENTITY_ACL_FIXTURE PASS'
} finally {
    foreach ($proc in $active) {
        try {
            if (-not $proc.HasExited) { $proc.Kill(); if (-not $proc.WaitForExit(5000)) { throw 'unverified process exit' } }
            $proc.Dispose()
        } catch { $cleanupFailed = $true }
    }
    foreach ($account in $created) {
        try { Remove-LocalUser -SID $account.SID -ErrorAction Stop } catch { $cleanupFailed = $true }
    }
    foreach ($secret in $secrets) { $secret.Dispose() }
    if ($rootCreated -and [IO.Directory]::Exists($root)) {
        try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { $cleanupFailed = $true }
    }
    if ($cleanupFailed) { throw 'Fixture cleanup failed; disposable runner must be discarded.' }
    Write-Host 'IDENTITY_FIXTURE_CLEANUP PASS'
}
