# Izakaya Tycoon (Roblox)

Run your own Japanese izakaya: claim a plot, cook dishes, seat customers, unlock upgrades, rebirth.

The code lives in this folder and [Rojo](https://rojo.space) syncs it into Roblox Studio.
You build the world and test in Studio, and you write code here.

## Folder layout

```
izakaya-tycoon/
├── default.project.json   tells Rojo where each folder goes inside Roblox
├── rokit.toml             which Rojo version this project uses
└── src/
    ├── server/  → ServerScriptService.Server       (only the server sees this)
    │   ├── Main.server.luau     starts every service
    │   └── Services/
    │       └── PlotService.luau builds plots, assigns them, sends players home
    ├── client/  → StarterPlayerScripts.Client      (runs on each player's device)
    │   └── Main.client.luau     HUD (shows your plot number for now)
    └── shared/  → ReplicatedStorage.Shared         (both sides can read it)
        └── Config.luau          numbers you can tweak
```

File names tell Rojo what to create in Studio:

| File name          | Becomes in Studio | Runs on |
|--------------------|-------------------|---------|
| `Name.server.luau` | Script            | server  |
| `Name.client.luau` | LocalScript       | client  |
| `Name.luau`        | ModuleScript      | whoever `require`s it |

**Golden rule:** money, purchases and ownership are only ever changed on the server.
The client shows things and asks the server; the server checks and decides.

## One-time setup

### 1. Install Rokit (it installs Rojo for you)

1. Go to <https://github.com/rojo-rbx/rokit/releases>, download the file for your computer
   (Windows: `rokit-…-windows-x86_64.zip`, Mac: `…-macos-aarch64.zip` for Apple Silicon or `…-macos-x86_64.zip` for Intel).
2. Unzip it and run the `rokit` file inside once (on Windows, double-click `rokit.exe`).
   It installs itself.
3. Close and reopen your terminal (Windows: PowerShell; Mac: Terminal), then run `rokit --version`
   to check it worked.

### 2. Install Rojo for this project

In a terminal, go to this folder and run:

```bash
cd path/to/Jarvis/izakaya-tycoon
rokit install
rojo --version        # should print 7.4.4
```

(If `rokit install` asks whether you trust `rojo-rbx/rojo`, answer yes.)

### 3. Install the Rojo plugin in Roblox Studio

Close Studio, then run:

```bash
rojo plugin install
```

Open Studio again. You should see **Rojo** in the **Plugins** tab.

> Prefer VS Code? The **Rojo** extension (by evaera) can install Rojo and the plugin and start
> the server from a button. Either way works; the steps below use the terminal.

### 4. Make the place and connect

1. In Studio, create a new **Baseplate** place.
2. **File → Publish to Roblox**, give it a name. (Saving DataStore progress, added in a later
   step, only works in a published place.)
3. **Home → Game Settings → Places** (or on the Creator Dashboard) set **Max Players to 6**,
   one per plot.
4. In the terminal, in this folder, run:
   ```bash
   rojo serve
   ```
   Leave it running.
5. In Studio: **Plugins → Rojo → Connect** (address `localhost`, port `34872`).
   It should say *Connected*.

Now every time you save a `.luau` file here, it appears in Studio within a second.

**Don't edit synced scripts inside Studio.** Rojo overwrites them, and the changes never reach these files.
Build the world (parts, models, lighting) in Studio as normal and save the place there.

## Build steps

- [x] **Step 1: project setup + plot claiming**
- [ ] Step 2: leaderstats (Cash, Rebirths) + DataStore saving
- [ ] Step 3: kitchen dropper + dishes that earn cash
- [ ] Step 4: buy-buttons for upgrades (dishes, tables, chefs, decorations)
- [ ] Step 5: NPC customers
- [ ] Step 6: rebirth
- [ ] Step 7: UI (cash counter, rebirth button, shop)
- [ ] Step 8: game pass hooks (2x Cash, Auto-Collect)

### Step 1: how it works

When the server starts, `PlotService` builds 6 empty plots from plain blocks in `Workspace.Plots`:
a wooden floor, a red sign on a post, and a pale square where the owner appears.
They sit in two rows facing a middle aisle, and the normal Baseplate spawn is in that aisle.

When a player joins, the server gives them the first free plot, turns the floor lighter,
writes "*Name*'s Izakaya" on the sign, and moves their character onto the plot
(also after every respawn). When they leave, the plot is emptied for the next player.
If all plots are taken, the player is told the server is full.

Each plot has an empty `Contents` folder; everything you unlock later is placed inside it.

### Step 1: what to test in Studio

1. With Rojo connected, check the Explorer has
   `ServerScriptService → Server → Main` and `Services → PlotService`,
   `ReplicatedStorage → Shared → Config`, and `StarterPlayer → StarterPlayerScripts → Client → Main`.
2. Press **Play**. Check that:
   - The Output window (View → Output) shows `[Izakaya Tycoon] Server started`, with no red errors.
   - Six wooden plots appear around the spawn; you start standing on one of them.
   - The sign on your plot shows your name, and your floor is lighter than the others.
   - The top of the screen says *Your izakaya: Plot 1*.
3. Reset your character (Esc → Reset Character). You should come back on your plot, not the middle.
4. Stop. Go to the **Test** tab, set **Clients and Servers** to **2 players**, and press **Start**.
   Each player gets a different plot and sign. Close one player's window: in the Server
   window, that plot goes back to dark with "Empty plot".
5. Try a change: in `src/shared/Config.luau` set `PLOT_SIZE = 100`, save, and press Play again.
   The plots are bigger. Put it back to 80.

Tell me when this works (or paste any red error from Output) and we'll do Step 2.
