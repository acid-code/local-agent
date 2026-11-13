# Windows laptop setup for the local-agent console.
# Explains each step, then does it. -WhatIf prints the plan and changes nothing.
#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ServerUrl = "http://100.64.0.1:8787",
    [string]$SshHost = "",
    [switch]$SshKey,
    [switch]$TerminalProfile
)

$ErrorActionPreference = "Stop"

function Explain([string]$Text) {
    Write-Host ""
    Write-Host $Text
}

function Invoke-Step([string]$Target, [string]$Action, [scriptblock]$Body) {
    Explain "$Action"
    if ($PSCmdlet.ShouldProcess($Target, $Action)) {
        & $Body
    }
}

Explain "This prepares this Windows laptop to reach the mini PC. It does not copy API keys onto the laptop. Keys stay in secrets.env and the vault on the box."

Invoke-Step -Target "Tailscale" -Action "Check Tailscale, and install it with winget if the tailscale command is missing." -Body {
    $tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($tailscale) {
        Write-Host "Tailscale is already installed: $($tailscale.Source)"
    } else {
        Write-Host "Running: winget install --exact --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements"
        winget install --exact --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements
        Write-Host "Open Tailscale from the Start menu and sign in to the same tailnet as the mini PC."
    }
}

if ($SshKey -or $SshHost) {
    Invoke-Step -Target "SSH key" -Action "Ensure an ed25519 key exists for this Windows user, then show the public half to add on the mini PC." -Body {
        $sshDir = Join-Path $env:USERPROFILE ".ssh"
        $keyPath = Join-Path $sshDir "id_ed25519"
        if (-not (Test-Path $sshDir)) {
            New-Item -ItemType Directory -Path $sshDir | Out-Null
        }
        if (-not (Test-Path $keyPath)) {
            Write-Host "Running: ssh-keygen -t ed25519 -f $keyPath -N (empty)"
            & ssh-keygen -t ed25519 -f $keyPath -N '""'
        } else {
            Write-Host "Key already exists: $keyPath"
        }
        $pub = Get-Content "$keyPath.pub" -Raw
        Write-Host "Public key:"
        Write-Host $pub
        if ($SshHost) {
            Write-Host "On the mini PC, append that line to ~/.ssh/authorized_keys for your Linux user."
            Write-Host "Then connect with: ssh $SshHost"
        }
    }
}

Invoke-Step -Target $ServerUrl -Action "Put a desktop shortcut named local-agent that opens the web console." -Body {
    $desk = [Environment]::GetFolderPath("Desktop")
    $file = Join-Path $desk "local-agent.url"
    $body = "[InternetShortcut]`r`nURL=$ServerUrl`r`n"
    Set-Content -Path $file -Value $body -Encoding ASCII
    Write-Host "Wrote $file"
}

if ($TerminalProfile) {
    Invoke-Step -Target "Windows Terminal" -Action "Add a Windows Terminal profile that SSHes to the mini PC, if settings.json is found and -SshHost was given." -Body {
        if (-not $SshHost) {
            Write-Host "Pass -SshHost user@100.x.y.z to create the terminal profile. Skipping."
            return
        }
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA "Microsoft\Windows Terminal\settings.json"),
            (Join-Path $env:LOCALAPPDATA "Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json")
        )
        $settingsPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $settingsPath) {
            Write-Host "Windows Terminal settings.json was not found. Install Windows Terminal, then re-run."
            return
        }
        $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
        $exists = $false
        foreach ($profile in $json.profiles.list) {
            if ($profile.name -eq "local-agent") { $exists = $true }
        }
        if ($exists) {
            Write-Host "Profile local-agent is already in $settingsPath"
            return
        }
        $profile = [pscustomobject]@{
            name = "local-agent"
            commandline = "ssh $SshHost"
            icon = "ms-appx:///ProfileIcons/ssh.png"
        }
        $json.profiles.list += $profile
        $json | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding UTF8
        Write-Host "Added profile local-agent to $settingsPath"
    }
}

Explain @"
PWA on this laptop: open $ServerUrl in Edge or Chrome, log in, then choose Install app (the icon in the address bar). The installed window is the same console. It does not store Gemini or vault keys; those stay on the mini PC.

Use the LAN address at home and the Tailscale address (100.x.y.z) at university. Pass that URL as -ServerUrl when you create the shortcut.
"@
