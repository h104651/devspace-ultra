$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'DevSpaceUltraAgent.vbs'

if (Test-Path $target) {
    Remove-Item -Path $target -Force
    Write-Host "[SUCCESS] Removed Agent from Windows Startup folder." -ForegroundColor Green
} else {
    Write-Host "[INFO] Agent was not registered in Windows Startup." -ForegroundColor Yellow
}
