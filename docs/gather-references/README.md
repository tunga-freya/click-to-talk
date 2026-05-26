# Gather UI references

Reference screenshots from gather.town that this app's UI should match.

| File | What it shows |
|---|---|
| `01-main-map.png` | Main map view — full office, top bar with location, bottom action bar (mic/cam/share/record/emoji), name-pill labels over avatars |
| `02-private-desk.png` | Standing at your own private desk — light highlight rectangle around the desk area, only avatar on the seat |
| `03-avatar-click-menu.png` | Clicking another user's avatar → dark popover with: avatar circle + status dot, name, "Available" status, location ("Can Sam's desk"), big Wave + Message buttons, then View profile / Locate on map / Follow / Request to join menu items |
| `04-someone-at-my-desk.png` | When a guest joins your private desk → a dark video tile docked at top showing them (or their avatar+mic icon if cam off), and both avatars rendered on the desk |
| `05-multiple-people-together.png` | 3 people in a private area → multiple video tiles at top, name pills under tiles + status (Away), avatars rendered grouped in the zone |
| `06-meeting-with-video.png` | Active meeting (camera on) → large video tiles fill the top half (real webcam feeds), small avatar tile for people with cam off. Top bar still visible. Bottom bar shows mic + cam ENABLED (green) |
| `07-screen-share-in-meeting.png` | Same meeting with someone sharing screen → left side: stacked vertical column of small video tiles. Main area: shared screen content. Top bar + bottom bar unchanged |

## UI tokens (extracted from screenshots)

- Top bar background: very dark navy `#1a1f2e` / `#0f1419`
- Bottom bar background: same dark navy
- Active mic/cam icon color: green `#10b981`
- Muted/off icon color: red `#ef4444` with strikethrough
- Avatar pill: dark `#1a1f2e` with white text, green dot `#22c55e` prefix
- Status indicator dot sizes: 8px (small inline), 14px (large on profile)
- Popover (avatar menu) background: very dark `#1a1f2e` with subtle border, rounded ~12px
- Primary button (Wave): purple-blue `#6366f1` / indigo-500
- Secondary button (Message): dark gray with light text
