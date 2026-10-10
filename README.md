<p align="center">
  <img src="public/img/logo-600.webp" alt="Pofak Stream" width="420">
</p>

<p align="center"><b>Movies · Pizza · Popcorn</b><br>
Your own little streaming site: search a movie or show, press <b>Watch</b>, and it plays
in seconds while it downloads in the background.</p>

---

## What is this?

Pofak Stream is a small website you run on your own computer (an old laptop is enough).
Everyone at home, or friends anywhere you share it with, opens it in a browser, logs in, searches,
and watches. No apps to install.

- **Search as you type.** Suggestions show the best-known titles first (*Breaking Bad*, *Interstellar*…).
- **Plays right away.** Videos stream while they download over BitTorrent, and you can skip ahead.
- **Series made easy.** Results go *Season 1 → Season 2…*, episodes in order, most popular release
  first. Season packs get an episode list, a **Next ▶** button, and auto-play of the next episode.
- **Subtitles that just appear.** The best match in your language (Persian, English, Arabic, …) loads
  automatically: exact-file matches first, then the release closest to yours. You can shift the timing ±0.5 s.
- **Tidy.** Only the episode you watch is downloaded. When you switch show, close the player, or leave,
  the download stops and its files are deleted (unless someone else is still watching it).
- **Private.** Everything is behind a login. Share it on the internet with one command, no router setup.
- **Light.** The page is about 50 KB, there's no transcoding, and it works on phones, tablets, TVs and laptops.

### Where do the movies come from?

| Source | What | Setup |
|---|---|---|
| **Internet Archive** | ~70,000 public-domain films, classic TV, cartoons | Built in |
| **Prowlarr** | Any torrent sites *you* choose | Pick sites at `http://<ip>:9696` |
| **Magnet link** | Paste any magnet / `.torrent` link | Footer of the page |

> ⚖️ **Legal note.** Pofak Stream is a tool, like a web browser or a torrent client. It ships with
> no torrent sites configured, and only the Internet Archive's public-domain collections are built in.
> Only stream content you have the right to. Downloading or sharing copyrighted material may be
> illegal where you live. What you add through Prowlarr or magnet links, and who you give access to,
> is your responsibility.

---

## Install (5 minutes)

You need **Docker**. Works on Linux (e.g. Linux Mint), Windows and macOS. Intel/AMD 64-bit.

```bash
# 1. Docker (Linux Mint / Ubuntu; on Windows/Mac install Docker Desktop instead)
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER        # then log out and back in

# 2. Get Pofak Stream
git clone https://github.com/sina4404/pofak-stream-public.git pofak-stream
cd pofak-stream
cp .env.example .env                 # your private settings file (see "Make it yours" below)

# 3. Start it
docker compose up -d
```

Open **`http://<this-computer's-ip>:8080`** (find the IP with `hostname -I`, or `ipconfig` on Windows).

**First visit:** you'll see *"Welcome! Create your account"*. Pick a username and password.
For safety this page only works from your **home network**, never over the internet.

That's it. Search, press **Watch**, enjoy. 🍿

---

## 🔐 Make it yours: your own keys and passwords

This project contains **no passwords, API keys or accounts**. Every install sets up its own.
Do these once:

**1. Your login (required).** Created on the first visit (see above).
- Use a **long password you don't use anywhere else** (12+ characters, e.g. three random words + a number).
  The minimum is 8, but your site may be on the internet.
- Only a scrypt *hash* is saved (in `data/users.json`), never the password itself.
- Forgot it, or want to change it? `docker compose exec mintstream node src/user.js add <name> "<new password>"`

**2. Prowlarr's own login (required if you use it).** Open `http://<ip>:9696`. Prowlarr asks you to
create its admin login on first open. Pick a different password from your Pofak Stream one.
Then **Indexers → Add Indexer** → choose sites → **Test** → **Save**. They appear in searches right away.

**3. Your own OpenSubtitles key (optional, for online subtitles).** Each install needs its own key:
1. Create a free account at [opensubtitles.com](https://www.opensubtitles.com).
2. Go to [opensubtitles.com/consumers](https://www.opensubtitles.com/consumers) → **New consumer** (any name) → copy the **API key**.
3. Either tick **Allow anonymous** on that consumer (5 subtitle downloads/day), or put your OpenSubtitles
   username/password in `.env` (20/day).
4. Put the key in `.env`:
   ```
   OPENSUBTITLES_API_KEY=paste-your-key-here
   ```
5. `docker compose up -d`. The log line `Online subtitles: OpenSubtitles` means it worked.

**4. Your own Cloudflare tunnel token (optional, for a permanent internet address).** See
[Share it on the internet](#share-it-on-the-internet-cloudflare-tunnel). The token goes in `.env` too.

**Keep these private:** `.env` (keys), `data/` (accounts + login key) and `prowlarr-config/` are already
in `.gitignore`. Never upload or share them. If you fork this project, check `git status` before pushing.

**Phone app icon:** open the site on your phone and choose **Add to Home Screen**.

---

## Accounts

```bash
docker compose exec mintstream node src/user.js add Ali "a-good-password"     # add / change password
docker compose exec mintstream node src/user.js remove Ali                    # remove (logs them out)
docker compose exec mintstream node src/user.js list
```

Accounts live in `data/users.json` (only password hashes, never passwords). Logins last 30 days;
10 wrong passwords lock that address for 15 minutes. Video links shown for VLC carry their own
signature and expire after 24 hours.

---

## Share it on the internet (Cloudflare Tunnel)

No router changes, your home IP stays hidden, HTTPS is automatic. Only Pofak Stream is exposed (Prowlarr isn't).

**Quick, temporary address** (no account needed; changes every time it restarts):

```bash
docker compose --profile quick-tunnel up -d
docker compose logs quick-tunnel | grep trycloudflare      # → https://<random-words>.trycloudflare.com
```

**Permanent address** (free Cloudflare account + a domain on Cloudflare):

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (*Cloudflared*), name it `pofak`.
2. Copy the token from the install command (the long text after `--token`) into `.env`: `TUNNEL_TOKEN=…`
3. In the tunnel's **Public Hostname** tab: e.g. `pofak.yourdomain.com` → Service **HTTP** → `mintstream:8080`.
4. `docker compose --profile quick-tunnel down` then `docker compose --profile tunnel up -d`

Viewers outside your home are limited by your internet **upload** speed.

---

## Everyday commands

```bash
docker compose up -d              # start / apply changes in .env
docker compose down               # stop
docker compose logs -f mintstream # see what it's doing
git pull && docker compose up -d --build   # update to the newest version
```

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `OPENSUBTITLES_API_KEY` | (none) | Turns on online subtitle search |
| `OPENSUBTITLES_USERNAME` / `_PASSWORD` | (none) | Higher subtitle download limit |
| `TUNNEL_TOKEN` | (none) | Permanent Cloudflare address |
| `WEB_PORT` | `8080` | Port of the website |
| `KEEP_DOWNLOADS` | `false` | Keep videos instead of deleting them when nobody watches |
| `IDLE_MINUTES` | `30` | Stop a video nobody has watched for this long |
| `MAX_ACTIVE_TORRENTS` | `3` | Videos downloading at the same time |
| `MIN_FREE_GB` | `2` | Refuse to start a video when the disk is almost full |
| `TZ` | `Etc/UTC` | Timezone for Prowlarr |

## Good to know

- **Browsers play `.mp4`/`.webm` everywhere; `.mkv` mostly in Chrome/Edge.** If a video won't play,
  the player shows a link: open it in **VLC** (*Media → Open Network Stream*). Nothing is re-encoded.
- **More seeders = faster start.** Results with few seeders can take a minute or not start at all.
- **Ports:** website `8080`, Prowlarr `9696`, torrents `6881` (TCP+UDP) and `6882` (UDP).
  Forwarding `6881` on your router makes torrents faster but is not required.
- The computer must stay on (disable sleep).

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone can't open the site | Same Wi-Fi as the computer? Firewall: `sudo ufw allow 8080/tcp`. Router "AP/client isolation" off? |
| "Nobody is sharing this torrent" | Pick a result with more seeders. |
| "Disk is full" | Free space, or lower `MIN_FREE_GB`. Old videos are removed automatically. |
| Subtitles: "needs a login to download" | Turn on *Allow anonymous* for your OpenSubtitles consumer, or add username/password to `.env`. |
| Forgot your password | `docker compose exec mintstream node src/user.js add <name> "<new password>"` |
| Torrent site "403 Forbidden" in Prowlarr | The site moved: pick another **Base URL** in the indexer, or another site. |

## How it works (for the curious)

```
Browser ──► Pofak Stream (Node.js, port 8080) ──► WebTorrent ──► torrent peers / archive.org
              │  search: Internet Archive + Prowlarr (your sites), ranked & grouped
              │  stream: HTTP range requests, pieces fetched in playback order
              │  subtitles: torrent .srt + OpenSubtitles, converted to WebVTT
              └─ login: scrypt hashes, signed cookies
Cloudflare Tunnel (optional) ──► the same port 8080, HTTPS from anywhere
```

Code: `src/server.js` (torrents, streaming, API), `src/search/*` (sources & ranking), `src/subtitles.js`,
`src/auth.js` + `src/users.js` (accounts), `public/` (the website, plain HTML/CSS/JS, no build step).

## License

[MIT](LICENSE): free to use, change and share. The Pofak Stream name and logo belong to the project author.
