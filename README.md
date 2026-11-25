# Point Crawl Map (Obsidian plugin)

Drop nodes on a map image, link them to notes, hide the map under animated fog, and show players a live view on GitHub Pages.

## Install (from source)

```bash
npm install
npm run build        # builds main.js and the player page (docs/js)
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/pointcrawl-map/`, then enable it. The OSHD icons are bundled inside `main.js`.

## Using it

1. Create a map: ribbon pin icon, or right-click a **folder** (map goes there) or an **image** in the file explorer → *New point crawl map*. It creates a `.pointcrawl` file.
2. **Move around**: left-drag the map, mouse wheel / pinch to zoom. **Right-drag pans with any tool selected** (the cursor becomes a grabbing hand and the tool is still selected when you let go). A right-click only opens the menu if you didn't drag. Space + left-drag and middle-drag also pan.
3. **Edit mode**
   - **Nodes**: right-click the map → *Add node here* (or double-click). Drag to move, right-click a node for Edit / Duplicate / Delete, Ctrl/Cmd-click opens its note.
   - **Pen** (Illustrator-style): click for a corner, click-and-drag for a curve with handles. Enter, double-click or right-click finishes; click the first point to close the shape; Backspace removes the last point; Esc cancels.
   - **Freehand**: drag to draw a smoothed line.
   - **Eraser**: trims freehand lines where you rub; pen lines are removed whole. `[` and `]` resize it.
   - Line colour, width and **solid / dashed / dotted / dash-dot** are in the toolbar. Click a line with the Select tool to restyle or delete it. Ctrl/Cmd+Z undoes.
   - **Edit lines**: with Select, click a line to select it, then drag it to move it, drag any point (or curve handle) to reshape it, double-click the line (or right-click → Add point here) to add a point, and press Delete (or right-click → Delete point, or Alt-click) to remove one. Right-click a pen point for *Make smooth / Make corner*.
   - **Text**: click the map with the Text tool. Choose a font, bold/italic, colour, size, an **arc** (bend the text up or down, up to a full circle), an **outline** (optionally blurred into a glow) and a **drop shadow**. Select text to **move** it, drag a corner to **scale** it, or drag the round handle to **rotate** it (hold Shift to snap). Double-click text to edit it. Text and lines sit under the fog like everything else.
   - **Colour palette**: your palette appears beside every colour picker (node colour and icon colour, line colour, text, outline and shadow, fog) and in the toolbar's palette button. It starts with a default set; add and remove colours in *Settings → General → Colour palette*.
   - **Fog**: Reveal and Add-fog brushes, undo, fog-all / clear-all.
4. **Ruler** (toolbar, also on the player page): drag to measure, Shift+drag to add another leg, click or Esc to clear. Distances use the map's scale.
5. **View mode**: clicking a pin opens its note.
6. **Player preview** (people icon): exactly what players see, with fog covering the whole screen.

Lines are stored as plain SVG path data, sit under the fog (so players only see what's revealed), and are sent to the player page.

Visibility per node: *Once its spot is revealed* (default), *Always*, or *GM only*.

## Keyboard shortcuts (Edit mode)

| Key | Action |
|---|---|
| V | Select |
| P | Pen |
| B | Freehand (brush) |
| E | Eraser |
| T | Text |
| F / G | Reveal fog / add fog back |
| R | Ruler (any mode) |
| 0 | Fit map to window |
| Space (held) | Pan with any tool |
| [ and ] | Smaller / larger brush or eraser |
| Enter | Finish a pen line |
| Delete | Delete the selected node, line, point or text |
| Esc | Deselect, cancel or clear the ruler |
| Ctrl/Cmd+Z | Undo (lines, points and text) |

Shortcuts work while the map has focus (click it first) and not while you are typing in a box.

## Scale

Images come in all sizes, so each map has its own scale (map settings → **Scale**): the **unit** (miles by default; also kilometres, leagues, feet, yards, metres, or your own like "days of travel") and the **map width**, meaning how far the full width of the image is. Or press **Calibrate with ruler…**, drag a line between two points whose real distance you know, and type that distance. The scale bar in the corner (shown to players too) updates as you zoom, and miles/kilometres switch to feet/metres when you zoom far in. Defaults for new maps are under *Settings → General*.

## Settings

Tabs: **General** (including your colour palette), **Nodes** (default look of new nodes, with live preview), **Drawing** (default line style), **Fog**, **Icons** (every icon, plus add your own from the vault), **Performance**, **Player site**.

Custom icons: *Settings → Icons → Add an icon → From vault…*. Single-colour icons (dark on white or transparent) are tinted with the node colour; switch that off to keep full colour. They are sent to the player page automatically when a visible node uses them.

## Player site

1. Create a **public** GitHub repo (it needs at least one commit), push this project's `docs/` folder to it (including `docs/js`, which holds the built player script), and enable **Settings → Pages → Deploy from branch → /docs**.
2. Create a fine-grained token with **Contents: read and write** on that repo. In the plugin settings enter the token and `owner/repo`, then press **Test**.
3. In a map: **Copy player link**, send it to your players, then switch on **Live** (radio icon). Changes push after a short delay (default 1 s) and the page checks for updates every 2 s, so a change normally shows up for players within a few seconds.

What gets published: a re-encoded WebP of the map (never the original), a small fog mask, and only the nodes players can currently see (their titles, icons and positions; never links to your notes). Everything lives on the `pointcrawl-data` branch, so Pages never rebuilds while you play. Anyone with the link can see it, and because the repo is public so can anyone who finds the repo.

### Install the player as an app

The player page is a progressive web app. Players can **Install** it from the browser menu (Chrome, Edge, Android) or **Share → Add to Home Screen** (iPhone/iPad) and it opens full screen like an app. It remembers the last map, caches itself so it opens instantly, and keeps each map image after the first download. Live map data is never cached, so it is always current. Touch panning has momentum, so a quick swipe glides and settles.

### How live updates work

With **Live** on, two things run at once:

1. **Instant (peer-to-peer).** Each player's browser opens a direct WebRTC connection to your Obsidian and your changes are sent straight down it, normally in well under a second. The toolbar shows ⚡ and how many players are connected. The player page shows nothing while all is well, and only displays a small notice at the top if the connection is lost or delayed. It uses two free public services, only to get the connection started: **ntfy.sh** (a few small messages on a topic named after the map) and **Google/Cloudflare STUN** (to find a route). Map data never goes through them. Turn it off with *Settings → Player site → Instant updates*.
2. **GitHub fallback.** Every change is also pushed to GitHub and each player's page reads it through the GitHub API every 2 seconds (never cached; unchanged replies are free against the rate limit). This covers players whose network blocks peer-to-peer (strict corporate or mobile networks; no free relay service exists for that) and anyone who joins while you're offline. If GitHub rate-limits a player, the page shows a small **Delayed updates** notice until it resets.

Direct connections only work while Obsidian is open with Live on, and everyone sees the newest state either way (older updates never overwrite newer ones).

## Performance notes

Large images are cut into 512 px tiles the first time a map opens (a half-size pyramid, stored in IndexedDB on this device). The map is usable within a second or two while finer levels build in the background (progress shows in the toolbar). After that the map opens instantly, and each frame only loads and draws the tiles in view. Memory stays bounded (default about 200 MB of decoded tiles), and there is no resolution cap: you always get the original detail when zoomed in.

- The first build decodes the whole image once, so it needs enough memory for that single decode. If the browser can't decode it, the plugin retries at a smaller size.
- Tiles are re-encoded as WebP (quality 0.92). Your original image is never modified.
- Changing or editing the image file rebuilds its tiles automatically. **Settings → Tile cache → Clear cache** wipes them.
- **Animate fog while editing** is off by default; players still see the animation.
- Fog is a small mask plus a few tiled noise textures, rendered at half resolution.

## Regenerating icons

`python3 scripts/gen-icons.py "/path/to/OSHD - Icons"` rewrites `src/icon-data.ts`, `src/shared/icon-index.ts` and `docs/icons/`.
