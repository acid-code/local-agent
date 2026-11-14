# local-agent on a Windows laptop (WSL2)

Ubuntu on WSL2, one small Ollama model, the console in the Windows browser, and the phone or the Windows exe on the same Wi-Fi. The commands below are the ones in this repo.

1. Install Ubuntu from the Microsoft Store (WSL2). The installer uses `systemctl`, so systemd has to be on. In Ubuntu, put this in `/etc/wsl.conf` (create the file if it is missing):

   ```
   [boot]
   systemd=true
   ```

   From Windows PowerShell run `wsl --shutdown`, then open Ubuntu again.

2. Install git and clone the repo. The server script installs git later, but clone needs it first:

   ```bash
   sudo apt-get update
   sudo apt-get install -y git ca-certificates curl
   git clone https://github.com/acid-code/local-agent.git
   cd local-agent
   ```

3. Install and start the server:

   ```bash
   sudo bash scripts/install-server.sh --native --with-ollama
   ```

   `--native` installs Node 22 when `node` is missing, runs `npm install` and `npm run build` in `/opt/local-agent`, and runs the app with Node under systemd. `--with-ollama` installs Ollama when `ollama` is missing. When Ollama is installed or that flag is set, the script writes `/etc/systemd/system/ollama.service.d/context.conf` with `OLLAMA_CONTEXT_LENGTH=32768`. It also installs Docker, the Compose plugin, git, and Mesa Vulkan when those packages are missing. The script adds your user to the `docker` group. This quickstart uses the Node service, so pull the model and open the console in this same terminal. A later `docker` command sees that group after a new WSL session (`wsl --shutdown` in PowerShell, then open Ubuntu again).

   It copies the tree to `/opt/local-agent` and writes `/opt/local-agent/.env` with `LA_HOST=0.0.0.0`, `LA_PORT=8787`, `DATA_DIR=/opt/local-agent/data`, `LA_COOKIE_SECRET`, and `OLLAMA_CONTEXT_LENGTH=32768`. The console listens on port 8787. The setup site listens on 8788 (`LA_SETUP_PORT` when set; 8788 is the default) and only on loopback and private LAN addresses.

   `systemctl is-active local-agent` prints `active` when the unit is up.

   The script prints `Setup token (one time):`. The service also prints `Setup token (one time, LAN only):` once, in `journalctl -u local-agent --no-pager`. If both scrolled away before an owner exists:

   ```bash
   cd /opt/local-agent
   npm run reset-owner
   ```

   That deletes the owner row and prints a new token. It takes no other flag.

4. Pull the small chat model. No extra flags:

   ```bash
   ollama pull qwen3:0.6b
   ```

5. On Windows, open `http://127.0.0.1:8788`. WSL forwards localhost, so the Windows browser reaches the setup site. Paste the token. The username is 1–32 characters from `a-z`, `A-Z`, `0-9`, `.`, `_`, and `-`. The password is at least 8 characters and must not be the token. Submit **Create owner**. Do this on port 8788 before using the console, so this page is the one that creates the account.

6. The next screen is Local models. Click **Scan**. It calls `POST /api/setup/detect`, which probes `http://127.0.0.1:11434`. The box should list the Ollama URL and `qwen3:0.6b`. Click **Cloud keys**. Leave the Gemini and OpenRouter fields empty and click **Notifications**. Saving a Gemini key writes `GEMINI_API_KEY` and enables the Gemini provider. Leave Telegram and IMAP empty and click **Backups**, then **Defaults**.

7. On Defaults, set Fast, Main, Coder, Thinking, and Smart / cloud to `qwen3:0.6b`. Leave Embed as `nomic-embed-text`. Embed is the knowledge-base model, not a chat role; search uses a local hash until that model is pulled. Click **Save defaults**. That sends `PATCH /api/setup/defaults` with `autoFast`, `autoMain`, `autoCoder`, `autoThinking`, and `autoCloud`.

8. Each start sets provider `prov_gemini` to enabled when `GEMINI_API_KEY` is in the environment or `data/secrets.env`, and to disabled when it is absent. Leaving that key blank is what keeps Gemini off after a restart. Smart / cloud set to `qwen3:0.6b` resolves that role to the local model. Port 8787 has its own `la_session` cookie; the setup cookie belongs to port 8788. To turn the provider off in the running process:

   ```bash
   curl -sS -c /tmp/la.cookies -H 'content-type: application/json' \
     -d '{"username":"YOUR_USER","password":"YOUR_PASSWORD"}' \
     http://127.0.0.1:8787/api/auth/login
   curl -sS -b /tmp/la.cookies -X PATCH -H 'content-type: application/json' \
     -d '{"enabled":false}' \
     http://127.0.0.1:8787/api/providers/prov_gemini
   ```

   The next start applies the key again.

9. Open `http://127.0.0.1:8787` in the Windows browser and sign in with the owner password. The session cookie is `la_session` for that origin.

10. The Windows shell is unsigned. SmartScreen shows **More info**, then **Run anyway**. On first launch, enter the server URL. The app remembers it and loads that origin in its own window, with the same cookie login as the browser. Change the URL later from the **Server** menu. On this laptop the URL is `http://127.0.0.1:8787`. The portable file is `local-agent-portable.exe`. The NSIS installer is `local-agent-setup.exe`.

11. For a phone or another PC on the same Wi-Fi, give WSL the Windows network stack. Create `%UserProfile%\.wslconfig`:

    ```
    [wsl2]
    networkingMode=mirrored
    ```

    From PowerShell run `wsl --shutdown`, open Ubuntu again, and run `sudo systemctl start local-agent` if `systemctl is-active local-agent` is not `active`. In an Administrator PowerShell window, once:

    ```powershell
    New-NetFirewallRule -DisplayName "local-agent" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787,8788
    ```

    `ipconfig` shows the Wi-Fi IPv4 address. In the phone APK and in the exe, use `http://<that-address>:8787`. With mirrored mode, that is also the address inside Ubuntu. Leave 8787 and 8788 closed on the router. The setup page refuses Tailscale (`100.64.0.0/10`) and public clients.

12. When mirrored mode is unavailable, keep WSL's NAT network and proxy the ports. In Ubuntu, `hostname -I` prints the WSL address. In Administrator PowerShell, substitute that address:

    ```powershell
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8787 connectaddress=<wsl-address> connectport=8787
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8788 connectaddress=<wsl-address> connectport=8788
    ```

    Use the firewall rule from the previous step. After a reboot the WSL address can change; run the two `netsh` commands again with the new address. The Windows browser can still use `http://127.0.0.1:8787`. The phone and the exe use the Wi-Fi address from `ipconfig`.
