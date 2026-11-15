# Release check

Use the [README](../README.md) for setup, roles, CSV columns, and media locations. This report records the release checks and a full party test you can run on your own network.

The public history has separate author commits for the original app and later changes. GitHub links both to their contributor accounts. Commit metadata uses no-reply addresses rather than personal email addresses.

## Automated checks

Checked on 2026-11-15:

| Check                                | Result                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                           | Passed: 18 tests, including a local HTTP/WebSocket party, host authentication, guest permissions, CSV/media import and export, session resume, and shared buzzer release. |
| `npm run format:check`               | Passed.                                                                                                                                                                   |
| `node scripts/validate-artifact.mjs` | Passed.                                                                                                                                                                   |
| `npm audit --audit-level=low`        | No known dependency advisories reported at check time.                                                                                                                    |
| Public file review                   | No personal names, real host codes, private quiz data, or credentials in the release files. Local data and personal quiz folders are ignored by Git.                      |

The app limits host sign-in attempts, uses a salted hash for the host code, rejects unrecognized hosts and cross-origin requests, and checks guest access to room data and media. These checks reduce risk but do not guarantee that the app has no vulnerabilities. It uses unencrypted HTTP on a trusted local network. Do not expose its port to the public internet.

## Test a full party yourself

Stop any running quiz server, then start a fresh test data folder from the project directory. This keeps your existing decks and results intact.

```sh
npm ci
QUIZ_DATA_DIR=.quiz-data/release-check npm start
```

1. Open `http://localhost:3000` on the host computer. Use the generated host access code printed in **your** terminal. Do not post it or a screenshot of it.
2. In **Themes**, choose a preset and save it. In **Quiz decks**, import a folder containing `questions.csv` and any referenced `media/` files, or use the included sample deck. Confirm question and answer images or audio load if you added them.
3. Start a quiz and give the session a name. Open **Open TV display** in a separate window. If the QR points to the wrong network address, use `QUIZ_PUBLIC_ORIGIN` as described in the README and restart the server.
4. On the same Wi-Fi, scan the QR with two phones. Join as two different teams. Run **Start buzzer check**. Each phone should register one test buzz; finish the check.
5. Select a question. Both phones should show a preparing state, then open together. Buzz on both phones, resolve the first answer, reveal the answer, and check the score on the host, TV, and phones.
6. While the teams remain joined, open a new host tab and sign in. Use **Resume host desk** or **Sessions**. Confirm it shows the same named session, joined teams, and scores. Refresh one team phone; it should resume its team.
7. End the quiz. Confirm the old QR and phone links no longer grant access, while **Sessions** still shows the finished results.

Keep the computer awake and the server running during the test. Buzzer order is the order the server accepts requests; network delay can affect very close taps.

If a step fails, note the step number, what appeared on each screen, and the browser/device types. Redact the host code, QR link, and any private questions before sharing a screenshot.
