# Deploy the Visa Bridge to a VPS

The bridge is a tiny Node forward proxy that tunnels each client's **real
browser** through the rotating residential proxy. It must run on a box with
a public IP (a VPS). Clients then point the extension's IP Rotation at this
VPS — **nothing runs on the client's machine**.

> Why a VPS and not Vercel? The bridge is a long-running TCP listener
> (CONNECT tunnels); serverless can't hold a socket. And it must be a
> *tunnel* (not a server-side fetch) so Cloudflare sees the client's real
> Chrome TLS fingerprint — that's the whole reason it passes challenges.

## 1. Get a VPS

Any cheap Linux box works ($4–6/mo: Hetzner, DigitalOcean, Linode).
Ubuntu/Debian recommended. Needs a public IP and one open port (8787).

## 2. Install Node 18+ on the VPS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v20.x+
```

## 3. Copy the files

From this repo, upload to the VPS:

```bash
scp local-bridge.js local-bridge-config.json root@YOUR_VPS_IP:/tmp/
sudo mkdir -p /opt/visa-bridge
sudo mv /tmp/local-bridge.js /tmp/local-bridge-config.json /opt/visa-bridge/
```

Or use `local-bridge-config.vps.json` from this folder as a starting
config (rename it to `local-bridge-config.json`).

## 4. Configure (critical!)

Edit `/opt/visa-bridge/local-bridge-config.json`:

```json
{
  "gateway": "p.webshare.io",
  "gatewayPort": 80,
  "baseUser": "YOUR_WEBSHARE_USERNAME_BASE",
  "pass": "YOUR_WEBSHARE_PASSWORD",
  "mode": "rotate",
  "listenHost": "0.0.0.0",
  "listenPort": 8787,
  "authRequired": true,
  "licenseServer": "https://visa-bypass.vercel.app"
}
```

- `listenHost` **must be `0.0.0.0`** so clients can reach it.
- `authRequired: true` means only clients whose extension holds a **valid
  license key** can open tunnels (the extension re-authorizes every ~8 min).
  Do **not** disable this on a public VPS — an open proxy is an abuse
  magnet and will burn your WebShare bandwidth.

## 5. Run as a service

```bash
sudo cp vps-bridge/visa-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now visa-bridge
sudo systemctl status visa-bridge   # should show "active (running)"
journalctl -u visa-bridge -f        # watch logs (authorizations + rotations)
```

## 6. Firewall

```bash
sudo ufw allow 8787/tcp
```

If your VPS provider has a cloud firewall (DigitalOcean/Hetzner), open
TCP 8787 there too.

## 7. Optional: a clean hostname

Add an A record, e.g. `proxy.suwate26.com → YOUR_VPS_IP`. Clients then
enter host `proxy.suwate26.com`, port `8787` — nicer than a bare IP.

## 8. Client setup (what you hand them)

1. Install the extension (Developer Mode — 2 min guided setup)
2. Popup → **IP Rotation** ON → host `YOUR_VPS_IP` (or hostname), port `8787` → **Save**
3. Activate their license key in the popup — this is what authorizes their
   IP on the bridge. Revoke the license server-side and their tunnels stop.

## Smoke test from the VPS

```bash
curl -s http://127.0.0.1:8787/status        # authRequired should be true
curl -s -X POST http://127.0.0.1:8787/rotate # expect {"ok":false,"error":"unauthorized"}
curl -s -X POST http://127.0.0.1:8787/auth -H 'Content-Type: application/json' \
  -d '{"licenseKey":"VISA-XXXX-XXXX-XXXX"}'  # expect {"ok":true,"ip":...}
curl -s -X POST http://127.0.0.1:8787/rotate # now works
```
