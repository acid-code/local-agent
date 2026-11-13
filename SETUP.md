# Setup on the mini PC, the laptop, and the phone

One machine holds the models, the chats, and the keys. The laptop and the phone are only windows onto it. A key typed on the mini PC never has to live on the phone, which is what makes university Wi-Fi safe enough.

Replace `asaf` below if that is not the Linux account on the box. The app login you create in the browser can use the same name. It is a separate password from the Linux one.

## Mini PC

The box is headless: Ryzen 7 8745HS, 48 GB, Radeon 780M. You administer it over SSH. The app binds to port 8787 on all interfaces, but you do not forward that port on the router. At home the laptop uses the LAN address. Everywhere else, Tailscale.

### Install script

Ubuntu or Debian. Clone the repo, look at the plan, then run it. The script is idempotent: a second run skips anything already installed and does not replace an existing `/opt/local-agent/.env`.

```bash
git clone https://github.com/acid-code/local-agent.git
cd local-agent
bash scripts/install-server.sh --dry-run --user asaf --with-ollama --with-tailscale
sudo bash scripts/install-server.sh --user asaf --with-ollama --with-tailscale
```

`--dry-run` prints every command and changes nothing. `--native` installs Node 22 and runs the process directly. Without that flag the systemd unit runs `docker compose up`. `--user` is the Linux account that owns the files. It is created if it does not exist, and it is added to the `docker` group. Vulkan/Mesa (`mesa-vulkan-drivers`, `libvulkan1`) is installed for the Radeon 780M. A cookie secret is generated into `.env` only when that file is missing.

The script prints the LAN URL, the Tailscale URL once Tailscale is up, and a one-time setup token. Then finish `tailscale up` if you asked for Tailscale. Open the LAN setup page next. The manual steps under that are the same packages the script installs, if you want to see each piece.

### LAN setup site

Keys, the owner password, Telegram, IMAP, model defaults, quotas, and backup targets are entered on a separate page. It listens on port 8788 and only on LAN addresses (RFC1918, link-local, and the machine itself). A request from Tailscale (`100.64.0.0/10`) or from a public address is refused. Docker publishes this page with host networking so the process sees the real client address and can bind those LAN interfaces. It is not mapped on `0.0.0.0`.

From a laptop on the same network:

```text
http://<lan-ip>:8788
```

The installer prints a one-time token. Paste it on the first screen, then choose the owner username and password. The token stops working after that. Later visits use the owner password. If you start the server yourself and miss the token, it is also printed on the process stdout the first time.

The wizard scans for a local model, then optionally saves a Gemini or OpenRouter key, a Telegram bot, IMAP, and a backup target. Test buttons check a key or send one Telegram message. Saving writes the encrypted vault and, for provider and Telegram values, `data/secrets.env` on this machine. Nothing on that form is synced, and the values are not returned to the page or given to a model. IMAP username and password stay in the vault. Host, port, and mailbox are ordinary settings.

An extra network can be allowed with `LA_SETUP_ALLOW` (comma-separated IPs or CIDRs) in the environment. Leave the tailnet out of that list. Do not forward port 8788 on the router.

If the app is already running in Docker, restart it after changing a provider key or Telegram token so the main process reloads `secrets.env`. A native install applies those values in the same process.

To remove the service and keep the data and keys:

```bash
sudo bash scripts/uninstall-server.sh
```

`--purge` also deletes `/opt/local-agent` and the `localagent` user when that was the account.

### 1. Install the pieces

On a Debian or Ubuntu box:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker asaf
curl -fsSL https://ollama.com/install.sh | sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Log out and back in so the `docker` group applies. `tailscale ip -4` prints the address you will use from the phone, something like `100.x.y.z`.

Pull one model first. A second large local model is refused while the first is resident, so do not pull Gemma 4 26B-A4B and Qwen3.6 35B-A3B and then load both.

```bash
ollama pull gemma4:e4b
```

The small Gemma is enough to leave Rehearsal behind. Add a 26B or 35B model later, when you want it.

### 2. Install local-agent

```bash
sudo mkdir -p /opt/local-agent
sudo chown asaf:asaf /opt/local-agent
git clone https://github.com/acid-code/local-agent.git /opt/local-agent
cd /opt/local-agent
npm install
npm run build
```

Create the env file. Leave the password unset. You will choose it in the browser, and it is the only password the laptop and phone need.

```bash
cp .env.example .env
```

`/opt/local-agent/.env` should contain at least:

```bash
LA_HOST=0.0.0.0
LA_PORT=8787
DATA_DIR=/opt/local-agent/data
```

Point systemd at that checkout:

```bash
sudo cp deploy/local-agent.service /etc/systemd/system/local-agent.service
```

Edit the unit and set `User=asaf` and `Group=asaf` so the process can read your SSH keys and the Docker socket (you are in the `docker` group). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now local-agent
sudo systemctl status local-agent
```

From the mini PC itself:

```bash
curl -s http://127.0.0.1:8787/api/health
```

`{"ok":true}` means the process is up. Do not open 8787 in the router. Tailscale is the remote path.

### 3. Create the owner account

Use the LAN setup page, `http://<lan-ip>:8788`, with the one-time token. That is also where provider keys, Telegram, IMAP, quotas, and backup targets belong. The chat UI on port 8787 can still claim the machine if you open it on the LAN before the setup page, but do not type keys into the chat UI from Tailscale.

On the LAN, from the laptop, you can also open `http://<lan-ip>:8787`. The first screen is “Claim this machine.” Pick a username and a password of at least 8 characters. That account is stored only on the mini PC. There is no default password.

If you would rather not use the LAN yet, tunnel it:

```bash
ssh -L 8787:127.0.0.1:8787 asaf@<lan-ip>
```

Then open `http://127.0.0.1:8787` on the laptop. The page is still the app on the mini PC.

### 4. Put credentials on the box

The LAN setup page is the place to type these. The same two stores are what it writes. Both stay on the mini PC.

**Provider keys and Telegram** are plain env values in `/opt/local-agent/data/secrets.env`, mode `0600`. The Gemini client and the Telegram bot read these. They are not shown to a model. Write them over SSH so the value never sits in the laptop browser or in shell history:

```bash
umask 077
touch /opt/local-agent/data/secrets.env
chmod 600 /opt/local-agent/data/secrets.env
read -rs GEMINI
printf 'GEMINI_API_KEY=%s\n' "$GEMINI" >> /opt/local-agent/data/secrets.env
unset GEMINI
```

Repeat for any of these names:

| Name | Used for |
| --- | --- |
| `GEMINI_API_KEY` | Cloud escalation. Local stays the default. |
| `OPENROUTER_API_KEY` | Optional second cloud provider. |
| `TELEGRAM_BOT_TOKEN` | Approval messages. Create the bot with BotFather. |
| `TELEGRAM_CHAT_ID` | Your chat with that bot. Send it one message, then read `https://api.telegram.org/bot<token>/getUpdates`. |

Restart so the process reloads the file:

```bash
sudo systemctl restart local-agent
```

In the app, open Models and enable the Gemini provider if it is still off. Settings, Gemini tier, stays on “Free tier” so the daily caps from the 13 Nov 2026 reading are enforced.

**Tool secrets** (GitHub tokens, MCP tokens, anything a shell command needs) go in the vault, not in the chat. Settings, Vault. The name looks like `GITHUB_TOKEN`. The value is encrypted in SQLite under `/opt/local-agent/data/master.key`. From then on the phone can ask an agent to use that credential. The model is told `secret:GITHUB_TOKEN` and never receives the value. The shell on the mini PC receives it as an environment variable for that command only. Each use is in the audit list under the vault.

You can also wait. If a run calls `request_secret`, the chat pauses and asks. Type the value there once. It is stored in the vault on the box. Prefer doing that from the laptop the first time, not by pasting a key into a normal message. If you do paste one, the composer offers to move it into the vault and strips it from the stored message.

Git push uses the Linux account, not the vault. Create an SSH key on the mini PC and add the public half to GitHub:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Clones and pushes then work as `asaf` on the box. The phone never holds that key. A push still asks for approval in the UI or in Telegram.

Projects you want a coder persona to touch have to be granted. They stay on the mini PC disk. In a coding chat, the agent calls `request_folder` with a path such as `/home/asaf/src/some-project`. You approve read or write. Until then, tools only see that persona’s workspace under `/opt/local-agent/data/workspaces/`.

MCP servers are added in Tools. Import finds Cursor, Claude, VS Code, and `~/.config` configs on the mini PC. Each one stays off until you vet it. Vetting searches the public web through SearXNG on this box, not a cloud model, then asks the local model to summarize those pages into the risk score. If SearXNG is down, the approval card says so and can start it. You can skip that search for a single install. Stdio servers run in their own container. Do not put a raw token in the MCP form if you can keep it in the vault and let the agent’s shell use the handle. Env saved on an MCP server record is stored with that record, not in the encrypted vault.

## Laptop

At home, bookmark `http://<lan-ip>:8787`. On university Wi-Fi, install Tailscale, sign in with the same tailnet, and bookmark `http://100.x.y.z:8787`. Same owner password. The session cookie is for that origin, so the LAN bookmark and the Tailscale bookmark are two logins. That is fine.

From PowerShell, `scripts/setup-client.ps1` does that setup and explains each step before it runs. `-WhatIf` prints the plan and changes nothing.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-client.ps1 -WhatIf -ServerUrl "http://100.x.y.z:8787" -SshHost "asaf@100.x.y.z" -SshKey -TerminalProfile
powershell -ExecutionPolicy Bypass -File .\scripts\setup-client.ps1 -ServerUrl "http://100.x.y.z:8787" -SshHost "asaf@100.x.y.z" -SshKey -TerminalProfile
```

It checks Tailscale and installs it with winget when the command is missing, writes a desktop shortcut to the console, and, with `-SshKey`, creates an ed25519 key if you do not have one and prints the public half for `authorized_keys` on the mini PC. `-TerminalProfile` adds a Windows Terminal profile that runs `ssh` to `-SshHost`. At the end it tells you how to install the PWA from Edge or Chrome. The script does not copy API keys onto the laptop.

Use the laptop for:

- The setup checklist (scan, pull a model, start SearXNG).
- Creating the house operator and the researcher, and a coder if you want edits.
- The first time you store a vault secret.
- Reading traces, approving a git push, granting a project folder.

Leave provider keys in `secrets.env` on the mini PC. Do not copy `secrets.env` or `master.key` onto the laptop. An API token (Settings is the vault page; create a token with `POST /api/tokens` while logged in, or add one from a small `curl` on the box) is the right thing to put in a script on the laptop. The token can call the API. It cannot reveal vault values unless you also send the owner password.

SSH when you need a shell on the box, including from university:

```bash
ssh asaf@100.x.y.z
```

Tailscale SSH is enough. You do not need a port forward.

## Phone

Install Tailscale and join the same tailnet. In the phone browser open `http://100.x.y.z:8787` and log in with the owner password.

Add it to the home screen so it behaves like an app:

- iPhone: Share, Add to Home Screen.
- Android: browser menu, Install app or Add to Home screen.

The service worker caches the shell. Chats still need the network. Push-to-talk appears on the composer as “Hold to talk”. It does nothing useful until faster-whisper is running on the mini PC. Kokoro is the matching voice. Both are optional and large:

```bash
cd /opt/local-agent
docker compose --profile voice up -d whisper kokoro
```

Or use Setup in the UI. The exact command is shown before it runs.

Telegram is the better approval path on a phone. After `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are in `secrets.env` and the service has been restarted, approval requests arrive with Approve and Deny. Failures, low RAM, and an empty Gemini day-cap arrive as messages. You still open the PWA to read the trace.

Do not keep a copy of API keys in a phone note. If a run needs a new key, wait until you are at the laptop or SSH, and store it on the box.

### Android app

The PWA above is enough. `apps/mobile` is a thin Capacitor shell for when you want a real APK: a home-screen icon, a share target, the microphone permission for push-to-talk, and a notification when an approval is waiting.

Capacitor is the shell, not a Trusted Web Activity. A TWA locks the app to one origin through Digital Asset Links. This box is reached at a LAN address and a Tailscale address, and either can change. The APK opens a one-page setup, you type the URL you want today, and the WebView then loads that origin. The chat, the trace, and the login stay the web console. A shared text (`ACTION_SEND` of `text/plain`) lands in the composer as `?share=`.

Notifications do not use Firebase. A WebView cannot be relied on for Web Push without Play services, and this box is not on the public internet. The shell asks for notification permission and, about every 15 minutes, polls `GET /api/approvals` with an API token. Create that token while logged in (`POST /api/tokens` with `{"name":"phone"}`) and paste the `la_…` value into the app’s optional token field. It is stored in the app’s preferences. It is not a Gemini key and it cannot reveal the vault.

Every push to `main` builds the APK and publishes a GitHub release tagged `main-<shortsha>`, marked latest. To sign it with a key you keep, add these Actions secrets on the repository (Settings, Secrets and variables, Actions). Do not commit the keystore.

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The keystore file, base64-encoded (`base64 -w0 local-agent.keystore`). |
| `ANDROID_KEYSTORE_PASSWORD` | The store password. |
| `ANDROID_KEY_ALIAS` | The key alias inside the store. |
| `ANDROID_KEY_PASSWORD` | The key password. |

Create the keystore once, on a machine you control, and keep the file with your backups:

```bash
keytool -genkeypair -v -keystore local-agent.keystore -alias local-agent -keyalg RSA -keysize 2048 -validity 10000
```

If any of the four secrets is missing, the workflow still publishes an APK signed with a throwaway debug keystore. That build installs, and a later release-signed APK will not update over it. The release notes say which kind of signature was used. The workflow does not run on pull requests, only after the commit is on `main`.

## What stays where

| | Mini PC | Laptop | Phone |
| --- | --- | --- | --- |
| Models, chats, vault, `secrets.env` | yes | no | no |
| Owner password, typed at login | stored here | typed, not saved in a file | typed, not saved in a file |
| Tailscale | `tailscale up` | app or package | app |
| SSH admin | the host | `ssh asaf@100.x.y.z` | optional |
| Approvals | the trace | the UI | Telegram or the UI |

A backup from Settings copies the database, the vault, `master.key`, and workspaces into `/opt/local-agent/data/backups`. That file is as sensitive as the keys. Copy it off the box with rclone or rsync only to a place you trust. Do not put it in the git checkout.
