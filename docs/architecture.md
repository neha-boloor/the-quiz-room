# Architecture

The frontend and quiz API are shared by two adapters. The standalone Node server supplies file-backed storage and local host authentication. An optional Sites Worker supplies platform identity and R2. Local behavior never calls the hosted Site.

## Persistence

`FileBucket` implements the small storage contract used by the API: get an object with its ETag, and conditionally put a replacement. Conditional local writes are serialized per key. Metadata and binary bytes are stored together and replaced with an atomic rename. Object keys are hashed into filesystem names; uploaded names cannot escape the data directory.

The authoring workspace stores deck definitions, theme settings and room index. Each room stores a frozen deck/theme snapshot, participant credentials, used tiles, queue, scores, ledger and processed command IDs. Uploaded media is stored separately. API updates retry conditional-write conflicts rather than dropping competing updates.

The host session list reads each stored room to calculate its current status and team count. Reopening the app resumes an active room, preferring the one with joined teams if older data contains multiple open rooms. Concurrent attempts to start a quiz select one room through a conditional workspace update. Ending or expiring a room revokes guest access while retaining its result record; rooms are not automatically deleted.

Only one local process may use a data directory. Network filesystems, multiple server replicas and power-loss durability guarantees are outside this adapter's scope. Stop the app before copying the entire data folder for a consistent full backup. Keep it private: it contains answer keys and active-room credentials.

## Authentication

Local mode never trusts incoming `oai-*` identity headers. The Node adapter strips them, verifies the local host cookie, and supplies a synthetic owner identity only for an authenticated host. The local owner ID is configurable internally and is unrelated to a real ChatGPT account. The host access code is salted and hashed using Node's scrypt; the plaintext is printed only when first created/reset, and is not stored. Session cookies are HttpOnly and SameSite=Strict, expire after eight hours, and are invalidated by restart.

The local app is HTTP on a trusted LAN. Cookies deliberately omit Secure there so phones can use the app without certificate setup. This is not a claim of transport encryption. The adapter rejects unrecognized hostnames, cross-origin requests and mismatched WebSocket origins, limits login attempts and caps request size. QR credentials and score data should never be routed through a public tunnel.

The optional Sites adapter relies on the platform's trusted identity headers. Its `OWNER_EMAIL` runtime configuration must identify the actual owner before publication. The local fallback owner address is intentionally not a real person's email. Do not expose the raw Worker behind an origin that permits forged identity headers.

## Realtime

The local WebSocket `/live` endpoint carries authorization-checked invalidation messages, not public room snapshots or write commands. A connection must authenticate its first message with a valid room credential or a host cookie. The server rechecks access before notifying a connection, including expiry/replacement. The client fetches a role-safe snapshot on notification. Ordinary HTTPS/HTTP mutation requests enforce command IDs and role checks. Sub-second local polling and automatic socket reconnection recover missed events and disconnections.

Question selection uses a readiness barrier. Each active team phone renders its armed state and acknowledges the current question epoch. Only after every active phone acknowledges does the server assign a future release timestamp. Phones and the TV estimate the server clock from their room response and unlock against that common timestamp; the server rejects buzzes before it. This keeps the question hidden during preparation and prevents a faster client from opening early.

The queue reflects server commits. Wi-Fi and device delays can affect order; it does not prove physical finger-tap ordering. One accepted attempt per team per question prevents a team from re-buzzing after its incorrect attempt is removed from the queue.

## Data exposure

Captains receive only permitted branding, score/queue state and board metadata. Stages receive the current released prompt and answer only after reveal. Neither role receives the deck answer bank or host notes. Media routes enforce the same roles. An empty, replaced, expired or ended credential is never valid. Ending a room revokes the join invitation, team and display credentials while retaining private results for the host.
