# local-agent

Your own AI assistant that runs at home on a small computer (the "mini PC"). You talk to it from your phone or laptop.
Your chats and files stay on your computer, not in someone else's cloud. It speaks English and Hebrew.

This guide takes you from a new mini PC in its box to the app open on your phone. It takes about an hour, mostly
waiting for downloads. Copy each command exactly: select it, copy, paste it into the terminal, press Enter.

**Words you will see**
- **Terminal**: a window where you type commands. On Ubuntu Server you are in one as soon as you log in; from a laptop, `ssh asaf@<mini-pc-ip>` opens one.
- **sudo**: runs a command as administrator. It asks for your computer password; nothing shows while you type it. That is normal.
- **Model**: the "brain" the assistant uses. You download it once and it runs on the mini PC.
- **Tailscale**: a free app that connects your phone to your mini PC safely from anywhere, like a private cable.

## Steps

**1. Plug in the mini PC.** Connect a screen, keyboard, mouse, the network cable (or Wi-Fi later) and power. Turn it on.
*You should see:* the maker's logo, then Windows or a setup screen.

**2. Install Ubuntu (the Linux system).** On another computer, download [Ubuntu Server 26.04 LTS](https://ubuntu.com/download/server) (the recommended system)
and write it to a USB stick (8 GB or more) with [balenaEtcher](https://etcher.balena.io). Plug the stick into the mini PC,
restart it and keep pressing `F7` (or `F11`/`Esc`, depending on the maker) to pick the USB stick. Choose
"Install Ubuntu Server", use the entire disk, and tick **Install OpenSSH server**. Pick a username (for example `asaf`) and a password you will remember.
*You should see:* a text login prompt after a restart. Log in; `ip -4 addr` shows the mini PC's address (`192.168.x.x`).

**3. Give the graphics chip a small memory slice.** Restart and keep pressing `Del` to open the BIOS (the settings
screen before the system starts). Find **UMA Frame Buffer Size** (often under Advanced → AMD CBS or Graphics) and keep it at
**Auto** (or 2–4 GB). Save and exit (`F10`). Why: the assistant borrows memory for graphics only when it needs it; [details](docs/models.md#gpu-memory-on-the-radeon-780m).
*You should see:* Ubuntu starts as before. If you cannot find the setting, skip this step.
Then let the graphics chip borrow ~38 GB of RAM: follow [GPU memory on the Radeon 780M](docs/models.md#gpu-memory-on-the-radeon-780m)
(one command and a reboot).

**4. Download local-agent.** Open a terminal and paste:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/acid-code/local-agent.git
cd local-agent
```

*You should see:* `Cloning into 'local-agent'...` and then the prompt again with no red errors.

**5. Install everything.** Paste this (change `asaf` if your username is different):

```bash
sudo bash scripts/install-server.sh --user asaf --with-ollama --with-tailscale
```

It installs the app, the model runner (Ollama), Tailscale and the graphics drivers. It takes 5–15 minutes.
*You should see at the end:* lines starting with `LAN: http://...`, `Setup (LAN only): http://...:8788` and
`Setup token (one time): ...`. **Write down the setup token**; you need it once in step 7. Do not share it.

**6. Connect Tailscale.** Paste:

```bash
sudo tailscale up
```

Open the link it prints, sign in (Google, Microsoft or Apple account is fine) and approve the device. Then paste
`tailscale ip -4` and write down the address.
*You should see:* an address like `100.101.102.103`.

**7. Create your account.** On a laptop on the same home network, open the browser and go to the
`Setup` address from step 5, for example `http://192.168.1.20:8788`. Paste the setup token, then choose your app username
and password (8+ characters; this is separate from the Ubuntu password).
*You should see:* your account is created and the page offers optional extras (a Gemini key, Telegram). You can skip them for now.

**8. Install the AI models.** From a laptop on the same network open `http://<mini-pc-ip>:8787`, sign in, and go to **Setup → Recommended models
for this machine**. It recognises the mini PC and lists one model per job (chat, Hebrew, code, reading pictures). Press
**Install recommended models**. About 45 GB downloads, which can take 30–60 minutes.
*You should see:* a progress line per model, ending with "Models installed and roles saved."

**9. Make it faster (optional, 2 minutes).** In the terminal, paste:

```bash
cd /opt/local-agent && sudo bash scripts/bench-runtime.sh gemma3:4b --apply
```

It tests whether the graphics chip makes the assistant faster and switches it on if so.
*You should see:* `Pick: ollama-vulkan` (graphics chip used) or `Pick: ollama-cpu` (processor only). Both are fine.

**10. Open it on your phone.** Install **Tailscale** from the App Store or Google Play and sign in with the same account as step 6.
Then open the phone's browser and go to `http://<address from step 6>:8787`, for example `http://100.101.102.103:8787`.
Sign in with your app username and password. To make it look like an app:
iPhone: Share → **Add to Home Screen**. Android: browser menu → **Install app**.
*You should see:* the chat screen. Type "שלום" or "hello" and you get an answer.

Done. The mini PC can stay on with no screen attached; the app starts by itself after a power cut.

## If something goes wrong

| Problem | Try this |
|---|---|
| A command says `Permission denied` | Put `sudo ` at the start and run it again. |
| `git: command not found` | Run `sudo apt install -y git`, then repeat the step. |
| The page does not open on the phone | Check Tailscale is switched **on** on both the phone and the mini PC (`tailscale status` on the mini PC). Use `http://`, not `https://`, and include `:8787`. |
| The setup page (8788) says refused | It only works from your home network, not over Tailscale. Use the mini PC itself or a laptop at home. |
| Lost the setup token | Run `sudo cat /opt/local-agent/data/setup.token` on the mini PC. If it is gone, the account already exists: sign in instead. |
| Answers are very slow | Run step 9. Check **Resources** in the app: if memory is full, pick a smaller model in Setup. |
| Model install stops with an error | Press Install again; it continues where it stopped. Check free disk space with `df -h ~`. |
| Is it running at all? | `curl -s http://127.0.0.1:8787/api/health` should print `{"ok":true}`. If not: `sudo systemctl restart local-agent`. |
| Something else | `sudo journalctl -u local-agent -n 50` shows the last messages; send them to whoever helps you. |

## More detail

- [SETUP.md](SETUP.md): every install step by hand, the laptop, the Android/Windows apps, where passwords and keys are kept
- [docs/models.md](docs/models.md): which models and why, graphics chip settings, speed test
- [docs/monitoring.md](docs/monitoring.md): checking on the assistant remotely
- [docs/personas.md](docs/personas.md), [docs/memory.md](docs/memory.md), [docs/images.md](docs/images.md): what the assistant can do
- [docs/overview.md](docs/overview.md): how it is built, for developers (`npm install && npm run dev`)
