param(
    [Parameter(Mandatory=$true)][string]$LiteralPath,
    [Parameter(Mandatory=$true)][ValidateSet('Directory','File')][string]$Kind,
    [switch]$Create
)
$ErrorActionPreference = 'Stop'
try {
    $full = [IO.Path]::GetFullPath($LiteralPath)
    if ($full -notmatch '^[A-Za-z]:\\') { throw 'IPC requires a local drive path.' }
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    # No reparse points anywhere on the credential path.
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Reparse point on IPC path.'
            }
        }
        $next = [IO.Path]::GetDirectoryName($ancestor)
        if ($next -eq $ancestor) { break }
        $ancestor = $next
    }
    # An ordinary different user must not be able to replace a private directory through its parent.
    $parent = [IO.Path]::GetDirectoryName($full)
    if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'IPC parent does not exist.' }
    $parentAcl = Get-Acl -LiteralPath $parent
    if ($trusted -notcontains $parentAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted IPC parent owner.' }
    $danger = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
              [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
              [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $parentAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and
            ($rule.FileSystemRights -band $danger) -ne 0 -and
            ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {
            throw 'Untrusted IPC parent replacement permission.'
        }
    }
    if ($Create -and -not (Test-Path -LiteralPath $full)) {
        if ($Kind -ne 'Directory') { throw 'Only directories may be created here.' }
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $security.SetOwner($sid)
        $security.SetAccessRuleProtection($true,$false)
        foreach ($value in $trusted | Select-Object -Unique) {
            $identity = [System.Security.Principal.SecurityIdentifier]::new($value)
            $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
            $security.AddAccessRule($rule)
        }
        [IO.Directory]::CreateDirectory($full,$security) | Out-Null
    }
    $item = Get-Item -LiteralPath $full -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($Kind -eq 'Directory') -ne [bool]$item.PSIsContainer) { throw 'Unexpected IPC object type.' }
    $acl = Get-Acl -LiteralPath $full
    if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted IPC owner.' }
    if ($Kind -eq 'Directory' -and -not $acl.AreAccessRulesProtected) { throw 'IPC directory DACL must be protected from inheritance.' }
    $userFull = $false
    foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow') {
            if ($trusted -notcontains $rule.IdentityReference.Value) { throw 'Untrusted IPC DACL entry.' }
            if ($rule.IdentityReference.Value -eq $sid.Value -and
                ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
                ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $userFull = $true }
        } elseif ($rule.IdentityReference.Value -eq $sid.Value) { throw 'Unexpected deny rule for current user.' }
    }
    if (-not $userFull) { throw 'Current user full access not verified.' }
    exit 0
} catch {
    # Do not reveal control file contents or credentials.
    [Console]::Error.WriteLine('IPC ACL validation failed: ' + $_.Exception.Message)
    exit 1
}
