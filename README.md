# The Quiz Room

A private, customizable quiz app for hosting friends at home. Create decks and category boards, customize the logo and backgrounds, show a question on the TV, and let one phone per team buzz and display its live score.

**Everything runs locally:** authoring, themes, uploaded media, QR joining, buzz order, scoring, undo, the TV display, history and backups. No ChatGPT account, API key, cloud storage, paid service or subscription is needed for local use. Internet is needed to install dependencies initially; after installation, local play works with the internet disconnected while your home network remains available.

## Quick start

Install **Node.js 22 or newer** (includes npm), then run:

```sh
npm ci
npm start
```

Open **http://localhost:3000** on the host computer. On first start, the terminal prints a newly generated **host access code**. Enter it under **Host sign in**. Keep it private and share it only with your co-host. There are no default credentials.

Your decks, themes, media, scores and history are saved in `.quiz-data/`. Restarting the server keeps them. This directory is ignored by Git. The host login cookie expires after eight hours or when the server restarts; sign in again with the same access code.

To stop the server, press **Ctrl+C**. To run it again, use `npm start`.

## Join from team phones

1. Connect the computer and captain phones to the same reachable home Wi-Fi network.
2. In the host app, create/edit a deck, save it, then select **Host quiz**.
3. The QR in the private host desk uses your computer's **LAN IP address**, not `localhost`. Scan it with one phone per team.
4. Enter a team name and join. No guest account or password is required.
5. Open a question and choose **Open buzzers**. Accepted buzzes appear in the host queue. Only hosts can change points.
6. **End quiz** expires the invitation and all team/display access. Results remain in private host history.

A phone's `localhost` means the phone itself. The QR therefore needs an address such as `http://192.168.1.25:3000`. If auto-detection picks a VPN or the wrong network interface, provide the correct LAN origin:

```sh
QUIZ_PUBLIC_ORIGIN=http://192.168.1.25:3000 npm start
```

Some guest Wi-Fi networks isolate devices. Allow the app's incoming connection in your computer's firewall and use a network that lets the phones reach the computer. No public tunnel or router port forwarding is needed. The computer must remain awake and the server must keep running.

## Host a quiz

- **Quiz decks:** create, duplicate, archive, restore, import or export decks. Each deck can have multiple boards.
- **Deck editor:** rename categories, resize the grid, select a tile, and enter its question, answer, hint, host notes, point value and optional image/audio/video. Save the deck.
- **Theme studio:** presets, logo/background uploads, colours, heading fonts, corner radius and background overlay. Save the household theme; a deck can choose a different preset.
- **Host desk:** show the QR, lock joining, select questions, open/close buzzers, advance the queue, reveal hints/answers, and add/subtract/set scores. Undo records a compensating adjustment.
- **Replace phone:** revoke the old captain. A new phone joins with the same team name and keeps the team's score.
- **TV display:** open the read-only display in a separate window. Extend your desktop onto the TV; do not mirror private host answers onto it.
- **Backups:** Settings → Export complete backup includes deck/theme definitions and referenced media. Restore imports that backup. Session history stays in the local data folder; back up that folder too for full recovery.

The sample deck is practice content. Replace the repeated sample variants before running a real party.

## Configuration

The app reads environment variables directly. It **does not automatically load `.env` files**. Export values in your shell or prefix the command as below. `.env.example` documents the available names.

| Variable             | Default                           | Purpose                                                                                     |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                            | Local server port                                                                           |
| `QUIZ_BIND`          | `0.0.0.0`                         | Listen on the home network; use `127.0.0.1` for computer-only access                        |
| `QUIZ_PUBLIC_ORIGIN` | Detected LAN address              | Origin encoded into the guest QR                                                            |
| `QUIZ_DATA_DIR`      | `.quiz-data/` in project root     | Persistent local data directory                                                             |
| `QUIZ_HOST_PASSWORD` | Randomly generated on first setup | Optional initial host access code, minimum 12 characters; does not replace an existing code |

For another port:

```sh
PORT=4000 npm start
```

For an explicit initial access code:

```sh
QUIZ_HOST_PASSWORD='your-own-long-private-code' npm run setup
npm start
```

To reset a forgotten access code, **stop the server**, then run:

```sh
npm run setup -- --reset
npm start
```

The new code is printed in that terminal. Restarting revokes old host cookies. Decks and results remain intact. Do not commit access codes or data files.

## Development and verification

```sh
npm ci
npm run dev
npm test
npm run format:check
```

`npm run dev` builds and starts the same real local server; it does not bypass host authentication. Restart it after editing source. `npm start` builds before launching, so a clean checkout works without a separate manual build command.

Tests cover authorization, concurrent buzzes/scores, idempotency, hidden answers, binary media, conditional-write conflicts, local HTTP/WebSocket updates, persistence across restart, phone replacement and immediate guest expiry. They create isolated temporary data directories and require no internet or cloud account.

```text
client/          Responsive studio, host, stage and captain UI
server/          Local HTTP/WebSocket server, private login and file persistence
shared/          Seed content, validation, storage contract and room projections
worker/          Portable API and optional Sites entry
scripts/         Build, setup, formatting and artifact validation
tests/          Core API and standalone local integration tests
docs/           Architecture and security notes
```

## Scope and limits

- Local updates use authenticated WebSocket notifications with a three-second polling recovery path. The Sites edition uses one-second polling. Buzz commands always go to the server immediately; committed server order decides the queue.
- Judge answers and award points manually. Automatic timers/marking, per-screen theme overrides, collaborative cursors and question-exposure warnings are not implemented.
- Upload limit is 10 MB per file. No paid transcoding service is used.
- Use **one server process per data directory**. This standalone edition is for a trusted home network, not an internet-facing hosting service.
- Local HTTP is unencrypted. Use an app-specific access code, and do not expose the server through router forwarding. Login checks, private cookies, origin/host validation and separate participant credentials protect application roles, but do not encrypt your Wi-Fi traffic.

The optional Sites deployment retains native ChatGPT identity and R2 storage. Local mode strips all client-supplied identity headers and uses its own private login. See [architecture](docs/architecture.md) for the separation.
