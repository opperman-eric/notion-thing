# Spoken Minutes

A private, iPhone-friendly JavaScript app for logging time in Notion by voice.

Tap record, say “I spent 16 minutes emailing stakeholders on Project B”, stop, review the details, and save. The app creates a **new time entry**, rather than changing an existing task’s minutes. You can also type a note. Audio is held in memory, sent to OpenAI, and discarded after processing; the app does not store recordings on disk. There is no offline mode.

## Notion setup

This app supports the structure in the screenshots:

```
Projects database
├── Project A (page)
│   └── Time Spent (inline database)
└── Project B (page)
    └── Time Spent (inline database)
```

Each `Time Spent` database needs these columns:

| Column | Notion property type |
| --- | --- |
| Task Name | Title |
| Date | Date |
| Minutes | Number |

An `ID` column can remain; Notion manages it. The Projects title column can have any name. Status is not changed.

1. Create an internal Notion integration at [Notion integrations](https://www.notion.so/profile/integrations). Give it read and insert content capabilities.
2. In Notion, open the Projects database → `…` → Connections → add that integration. Ensure it can also access the inline time databases (share them explicitly if necessary).
3. Copy the integration secret into `NOTION_TOKEN` in Render.
4. Copy the Projects database ID from its URL into `NOTION_PROJECTS_DATABASE_ID`. For `https://www.notion.so/workspace/0123456789abcdef0123456789abcdef?v=...`, use `0123456789abcdef0123456789abcdef`. Do not use the view ID after `?v=` or a project page ID.

The app discovers a directly nested inline database titled `Time Spent`. If your table is a linked view or is nested inside a toggle, supply the real database IDs with the optional `NOTION_TIME_DATABASE_MAP` environment variable:

```json
{"project-page-id":"time-database-id","another-project-page-id":"another-time-database-id"}
```

Use real Notion IDs in place of those labels. Each mapped database should be dedicated to that project; shared relation-based time tables are not supported. If the Projects database has multiple data sources, set `NOTION_PROJECTS_DATA_SOURCE_ID`. Each time database must have one data source. Column names and the time database title can be overridden with the variables in `.env.example`.

## Deploy on Render

1. Push this repository to your GitHub account.
2. In [Render](https://dashboard.render.com/), create a Blueprint from that repository using `render.yaml`. Alternatively, create a Node Web Service with build command `npm install --omit=dev` and start command `npm start`; select Node 22.16 or newer.
3. Set the four required secret environment variables:

   | Variable | Value |
   | --- | --- |
   | `OPENAI_API_KEY` | Your OpenAI API key with API billing enabled |
   | `NOTION_TOKEN` | Your Notion integration secret |
   | `NOTION_PROJECTS_DATABASE_ID` | The Projects database ID |
   | `APP_PASSWORD` | A unique password of at least 12 characters |

4. Deploy, open the HTTPS URL in Safari on your iPhone, and sign in using your app password.
5. Allow microphone access when prompted. Optional: Safari Share → Add to Home Screen.

Enter secrets in Render’s environment settings, **not** in browser code or Git. OpenAI API usage is billed separately from a ChatGPT subscription. The default models are `gpt-4o-mini-transcribe` and `gpt-4o-mini`; override `TRANSCRIPTION_MODEL` and `EXTRACTION_MODEL` if required. The extraction model must support strict JSON schema output. Dates default to the current day in `Pacific/Auckland`; change `TIME_ZONE` for another IANA timezone. Explicit dates such as “yesterday” are interpreted before review.

## Run locally

Install Node.js 22.16 or newer, then in PowerShell:

```powershell
Copy-Item .env.example .env
# Fill in the four required settings in .env.
npm start
```

Open `http://localhost:3000`. Localhost supports microphone access on the same device. Accessing a computer’s plain HTTP LAN address from an iPhone does not; use the Render HTTPS deployment for phone testing.

```powershell
npm run check
npm test
```

There are no third-party runtime dependencies or build step. Tests use mocked API responses and do not spend OpenAI credits or change Notion.

## Behavior and limits

- Recordings stop at two minutes, on leaving the page, or at the size limit (12 MB). iPhone MP4 and browser WebM recordings are supported.
- Missing or uncertain fields stay blank for manual selection. Nothing is written until you press Save to Notion.
- Database membership and destination property types are checked on the server before writing.
- A save identifier prevents duplicate submissions **within a running server process**. Successful retries return the original result. If a write times out, check Notion before starting a new entry: Notion does not provide an atomic idempotency key for this operation.
- Sessions and save identifiers live in memory. Restarting or sleeping the service signs you out and clears duplicate protection. Use one server instance; durable shared state is needed before scaling to multiple instances.
- This is a personal, password-protected app. Login attempts are limited, cookies are HttpOnly, and production cookies are Secure. Keep the password private. Recordings and notes are sent to OpenAI; reviewed task details are sent to Notion.
- If a project will not save, check integration access, the `Time Spent` title, and column types. For an uncertain save, inspect Notion before submitting again.

Implementation references: [OpenAI speech to text](https://developers.openai.com/api/docs/guides/speech-to-text), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Notion data sources](https://developers.notion.com/reference/query-a-data-source), and [Render Node versions](https://render.com/docs/node-version).
