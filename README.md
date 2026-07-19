# ⛏ VoxelDeck

A slick, dark-themed desktop app for managing your game servers — **Minecraft,
Terraria, and Valheim** — from one place. Set things up, browse and edit files,
watch a live console, and flip a toggle to start or stop each server. Each game
gets a tailored experience (Minecraft keeps RAM/EULA/mods/players; Terraria and
Valheim get one-click install and their own config), while the core — multiple
servers, console, files, auto- and scheduled restarts — is shared.

![Built with Electron](https://img.shields.io/badge/Electron-dark--theme-3fb950)

## Features

- **Play — Singleplayer launcher with easy modding (Minecraft).** Beyond running
  *servers*, VoxelDeck can launch the game itself. Open **🎮 Play (Singleplayer)**,
  sign in with your **Microsoft account** (the same login the official launcher
  uses — you play with an account that owns the game), then create an **instance**:
  pick a Minecraft version and a mod loader — **Vanilla**, **Fabric**, or
  **Quilt**. VoxelDeck downloads the client, libraries, assets and the right
  **Java runtime automatically**, then launches. Each instance is its own isolated
  world folder, and for Fabric/Quilt instances you get **one-click modding**:
  browse Modrinth and install mods straight into that instance, toggle or remove
  them, or drop in local `.jar`s. Requires a one-time Azure app registration —
  see [Microsoft login setup](#microsoft-login-setup-for-the-singleplayer-launcher).
- **Multiple games — Minecraft, Terraria & Valheim.** Pick the game when you add
  a server and VoxelDeck adapts: it installs the right server (downloads the
  Minecraft jar, the Terraria dedicated server, or runs SteamCMD for Valheim),
  shows only the tabs that game supports, and gives each its own settings.
  Minecraft is the most full-featured (RAM, EULA, `server.properties`, players,
  mods); Terraria adds a console, players and a `serverconfig.txt` editor;
  Valheim installs via SteamCMD and stops gracefully (it has no console, so it's
  shut down with a signal so the world saves).
- **Interactive guided tour** — a hands-on first-run walkthrough that actually
  walks you through creating your first server: it waits for you to click **+**,
  highlights each field in the Add-server window as you fill it in, waits for you
  to click **Create**, then spotlights the real tabs of the server you just made
  and explains what each does. Skippable, remembered after it's seen, and
  replayable from ⚙ App settings.
- **Auto-updates** — checks GitHub for new releases on launch and updates itself
  (Windows installer & Linux AppImage), with a "Restart & update" prompt and a
  manual "Check for updates" in ⚙ App settings.
- **Overview home page** — a dashboard landing page with a card for every server
  showing its status, type, player count and RAM, plus a **start/stop toggle** on
  each card. Click a card (or the sidebar) to open that server; click **Overview**
  or the logo to come back.
- **Multiple servers** — manage as many as you like from one sidebar, each with a
  live status dot (stopped / starting / running / stopping).
- **Automatic folder setup** — adding a server creates and scaffolds its folder for
  you: it makes a uniquely-named folder, copies in the `.jar` you point to, creates
  the `plugins/`/`mods/` directory, and auto-detects the software type from the jar.
- **Start/stop toggle** — one switch per server. Stopping sends a graceful `stop`
  to the console, then escalates to SIGTERM/SIGKILL if needed.
- **Live console** — real-time output with WARN/ERROR highlighting, a command
  input (with ↑/↓ history), and player-count tracking.
- **Players panel** — a live list of who's online, each with an **OP toggle**
  (reads/writes `ops.json` via `op`/`deop`) and a **gamemode dropdown**
  (survival / creative / adventure / spectator). Updates as players join and leave.
- **Quick Commands** — a friendly tab of common admin actions (whitelist, ban,
  kick, teleport, set time/weather/difficulty, give items, XP, effects, game
  rules, broadcast, save…) as fill-in-the-blank cards with dropdowns and a live
  command preview — no need to know Minecraft command syntax.
- **RAM control** — min/max heap sliders that cap at your system's total RAM.
- **Change server software** — pick any `.jar` in the server folder, or browse to
  one. Choose the type (Vanilla, Paper, Purpur, Spigot, Fabric, Quilt, Forge,
  NeoForge…) which decides whether the app manages a `plugins/` or `mods/` folder.
- **One-click jar download** — for Vanilla, Paper, Purpur and Fabric, the app can
  fetch the server jar straight from the official source: pick a Minecraft version
  and it downloads (with a progress bar) into the server folder and selects it
  automatically. Other types link out to their official download page.
- **File manager** — browse the server directory, view/edit text files (with a
  built-in editor and Ctrl+S to save), create files/folders, rename, delete, and
  import files from anywhere on disk. Sandboxed to each server's folder.
- **Mods / Plugins manager** — list installed `.jar`s, enable/disable them with a
  switch (toggles a `.disabled` suffix), add new ones, and remove them.
- **Client-side mod installer** (Minecraft) — every server gets its own **client
  mod profile**: the mods a *player* needs on their own machine to join that
  modded server. Browse Modrinth for **client-side mods** — only mods that run on
  the client are shown, for the client loader you pick (Fabric, Quilt, Forge or
  NeoForge, independent of the server's software) and matched to your Minecraft
  version — or add local `.jar`s; they download into a per-server cache. Then hit **⬇ Apply to my Minecraft** and pick where to install:
  an **isolated profile folder** under `.minecraft/voxeldeck-profiles/<server>/`
  that VoxelDeck keeps in exact sync (point a launcher profile at it — nothing
  else is touched), or your **main `.minecraft/mods`**, where anything already
  there is moved to a timestamped backup folder first so the swap is reversible.
  Set the Minecraft folder in **⚙ App settings** (auto-detected per-OS by default).
- **server.properties editor** — a friendly form for the common settings
  (MOTD, gamemode, difficulty, max players, port, PvP, whitelist, view distance…).
- **EULA & Java helpers** — one-click EULA acceptance and Java auto-detection with
  clear warnings if Java is missing or a custom path is needed.
- **Backups & restore** — snapshot the entire server folder (world, mods,
  configs) into a single `.zip` with one click, browse past backups with their
  size and date, and **restore** any of them (a safety snapshot of the current
  world is taken automatically first, so a restore is undoable). Optional
  **scheduled daily backups** with a retention limit keep the newest N automatic
  backups and prune the rest; manual backups are never auto-deleted. Zipping and
  unzipping run on a worker thread so the UI never freezes, and backups are stored
  outside the server folder (configurable in ⚙ App settings) so they survive
  deleting a server. Works for Minecraft, Terraria and Valheim.
- **Auto-restart** (optional) — bring a server back up automatically if it crashes.
- **Scheduled daily restarts** (optional) — pick a time of day and the app warns
  players in chat, then gracefully stops and restarts the server (only if it's
  running, and while the app is open) — handy for keeping long-running servers
  healthy.
- **Customizable accent color** — pick a preset or any custom color in
  **⚙ App settings**; it applies live and is remembered across launches.

## Requirements

- **Linux** with **Node.js 18+** (you have Node 26 ✓).
- **Java** (Minecraft only) — Minecraft servers are Java programs. The app
  detects Java, warns if it's missing, and can download the newest for you.
  Recommended: [Adoptium Temurin](https://adoptium.net/). On Arch/CachyOS:
  `sudo pacman -S jdk21-openjdk`; on Debian/Ubuntu: `sudo apt install openjdk-21-jre`.
- **SteamCMD** (Valheim only) — Valheim's dedicated server is installed through
  SteamCMD, so it must be on your PATH (Debian/Ubuntu: `sudo apt install steamcmd`,
  Arch: `yay -S steamcmd`). If it's missing, VoxelDeck tells you how to get it.
- **Terraria** needs nothing extra — VoxelDeck downloads the official dedicated
  server for you.

## Microsoft login setup (for the singleplayer launcher)

The **🎮 Play (Singleplayer)** launcher signs you in with a real Microsoft
account, exactly like the official launcher and Prism/MultiMC. Microsoft only
issues Minecraft-scoped tokens to an **Azure application** that the project owner
has registered, so this is a **one-time setup** you (the maintainer) do before
shipping. Until it's done, the launcher shows *"Microsoft login isn't configured
yet"* and the **Sign in** button is disabled — instance creation and downloads
still work; only launching needs it.

1. Go to the [Azure Portal](https://portal.azure.com) → **App registrations** →
   **New registration**.
   - **Supported account types:** *Personal Microsoft accounts only*.
   - No redirect URI is needed (we use the OAuth **device-code** flow).
2. Open the new app → **Authentication** → **Advanced settings** →
   set **Allow public client flows** = **Yes**.
3. Request Minecraft API access for the app as described in Mojang's
   [developer article](https://help.minecraft.net/hc/en-us/articles/16254801392141).
4. Copy the **Application (client) ID** and provide it to VoxelDeck one of two ways:
   - set the environment variable `VOXELDECK_MS_CLIENT_ID=<your-client-id>` before
     launching, **or**
   - replace the `CLIENT_ID` constant near the top of
     [`src/main/msauth.js`](src/main/msauth.js).

That's it — the entire device-code → Xbox Live → XSTS → Minecraft token chain,
token refresh, and per-launch validation are already implemented.

> **Note:** the launcher is for playing with an account that **owns** Minecraft
> (Java Edition); it is not a way to bypass ownership.

## Quick start

```bash
npm install        # one time — downloads Electron
npm start          # launch the app
```

To make it a real app in your application menu:

```bash
npm run install-desktop      # adds a launcher; uninstall with: bash scripts/install-desktop.sh --uninstall
```

## Adding your first server

The dashboard **creates and sets up the server folder for you** — you don't need
to make folders or move files around yourself.

1. Click **＋ Add a server** (sidebar or empty state).
2. Give it a name and click **Choose .jar…** to point at your server `.jar`
   anywhere on disk. The app **copies it into a new folder** it creates for you
   (shown in the live "Creates: …" preview), and **auto-detects the software type**
   from the jar's name. It also pre-creates the `plugins/` or `mods/` folder.
3. In **Settings**: set **RAM**, and (first time) click **Accept EULA**.
4. Flip the **toggle** at the top-right to start it. Watch the **Console**.

New servers are created under your **Servers folder** (default `~/MinecraftServers`,
configurable in **⚙ App settings**). You can still point a server at an existing
folder instead — just edit its folder in the server's **Settings** tab.

Once it's running, type commands in the console (`op <you>`, `whitelist add <you>`,
`say hello`, `stop`, …) just like a normal server terminal.

## Windows & macOS

The app is built on Electron and is cross-platform — the same code runs on
Windows, macOS and Linux. Paths, the config location (`%APPDATA%` on Windows),
Java launching, and the file picker are all OS-aware.

**To run it on Windows:**

```powershell
npm install
npm start
```

(Install [Node.js](https://nodejs.org/) and [Java 21+](https://adoptium.net/)
for Windows first.) The default servers folder becomes
`C:\Users\<you>\MinecraftServers`.

**To build a Windows installer / portable exe:**

```powershell
npm install --save-dev electron-builder
npm run dist:win        # produces an NSIS installer + a portable .exe in dist\
```

> The `install-desktop` launcher script is Linux-only (it writes a `.desktop`
> file). On Windows, use `npm start` or the built `.exe`; the installer adds
> Start-menu/desktop shortcuts for you.

Only Linux was used during development and testing, but the code paths are
platform-neutral.

## Packaging for distribution

`electron-builder` is configured (see the `build` block in `package.json`).

```bash
npm install                 # includes electron-builder (devDependency)
npm run dist                # Linux:   AppImage + .deb     -> ./dist
npm run dist:win            # Windows: NSIS installer + portable .exe -> ./dist
# (macOS dmg target is configured too; build it on a Mac)
```

Produced artifacts (in `./dist`):

| File | Platform | What it is |
|------|----------|------------|
| `VoxelDeck-1.0.0.AppImage` | Linux | Portable — `chmod +x` and run |
| `voxeldeck_1.0.0_amd64.deb` | Linux | Install with `sudo dpkg -i …` (Debian/Ubuntu) |
| `VoxelDeck Setup 1.0.0.exe` | Windows | NSIS installer (adds Start-menu/desktop shortcuts) |
| `VoxelDeck 1.0.0.exe` | Windows | Portable — double-click, no install |

Building Windows targets on Linux requires **Wine** (`/usr/bin/wine`). The first
build downloads extra tooling (NSIS, fpm, etc.) into `~/.cache/electron-builder`.

### Before you distribute publicly — read this
- **Code signing.** These builds are **unsigned**, so Windows SmartScreen and
  macOS Gatekeeper will show "unknown publisher / unidentified developer"
  warnings that scare off buyers. For a paid product, get a code-signing
  certificate (Windows ~$100–400/yr; Apple Developer $99/yr) and set
  `win.certificateFile` / macOS signing in the build config.
- **Update the placeholders** in `package.json` before shipping: `author`,
  `homepage`, and `build.linux.maintainer` currently hold placeholder values.
- **Branding.** Don't market it as an official "Minecraft" product — Mojang/
  Microsoft brand guidelines prohibit implying affiliation. A distinct name plus
  "for Minecraft servers" is the safe framing. (`productName` / `appId` in the
  build config control the displayed name and identity.)

## Where things are stored

- Server **and** singleplayer-instance configurations, plus app settings and your
  signed-in Microsoft account: `~/.config/voxeldeck/servers.json` (migrated
  automatically from the old path).
- Singleplayer launcher files: shared client versions/libraries/assets live in
  `~/.config/voxeldeck/launcher/` (deduped across instances), downloaded Java
  runtimes in `~/.config/voxeldeck/runtimes/`, and each instance's own world/mods
  folder under `~/.config/voxeldeck/instances/` (configurable via
  `settings.instancesRoot`).
- Your actual server files stay wherever you put them. In a server's **Settings →
  Danger zone** you get two choices: **Remove from dashboard** (the default — takes
  it out of VoxelDeck but leaves every file on disk), or **Delete server & all
  files**, which permanently erases the whole server folder. The permanent option
  makes you retype the server's exact name and wait out a short cooldown first, and
  it is **irreversible** — there's no trash or backup, so the server can't be
  restored afterward.

## Project layout

```
src/
  main/            Electron main process (Node)
    main.js          window + all IPC handlers
    serverManager.js process lifecycle, console I/O, start/stop
    store.js         JSON persistence of server + instance configs & account
    files.js         sandboxed file operations
    serverUtils.js   java detection, server.properties, eula, mods/plugins
    clientMods.js    client-side mod profiles: cache, download & apply to .minecraft
    backups.js       per-server backups: create/list/restore/prune (+ backupWorker.js)
    launcherManager.js singleplayer instances: install + launch lifecycle
    mojang.js        vanilla client pipeline (jar, libs, natives, assets, launch args)
    loaders.js       Fabric & Quilt mod-loader meta (profile JSON)
    msauth.js        Microsoft device-code auth → Xbox → Minecraft token
  preload/
    preload.js       safe contextBridge API (the only renderer ↔ main surface)
  renderer/
    index.html       UI structure
    styles.css       dark theme
    renderer.js      all UI logic
test/
  core.test.mjs        unit tests for file/properties/eula/content logic
  lifecycle.test.cjs   start → run → console → stop, using a fake Java
  client-mods.test.cjs client mod cache + apply (isolated sync vs. backup-and-swap)
  backups.test.cjs     backup round-trip: create → restore → prune (real worker)
  launcher.test.cjs    launcher logic: OS rules, classpath/natives, launch args, loader merge
  clientmods-smoke.cjs dev tool: drives the Client Mods tab/modals in Electron
  backups-smoke.cjs    dev tool: drives the Backups tab (create/restore/delete)
  shoot.cjs            dev tool: screenshots each view via Electron
```

## Tests

```bash
npm test           # runs core + lifecycle test suites
```

## Security notes

The renderer runs with `contextIsolation` on and `nodeIntegration` off. It can
only reach the main process through the audited `preload.js` bridge, and all file
operations are resolved against (and confined to) the selected server directory —
`../` traversal is rejected.

## License

MIT
