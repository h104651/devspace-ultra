$startup = [Environment]::GetFolderPath('Startup')
$vbs = 'C:\Users\testuser\Desktop\devspace-ultra\scripts\launch-daemon.vbs'
$target = Join-Path $startup 'DevSpaceUltraAgent.vbs'

Copy-Item -Path $vbs -Destination $target -Force
Write-Host "[SUCCESS] Registered Agent to Windows Startup folder: $target" -ForegroundColor Green
