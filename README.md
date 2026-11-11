# NEXORAGPT

A self-hosted AI chat and image workspace powered by [AI Horde](https://aihorde.net/). It opens directly into a private guest workspace. No email address, password, signup, or account creation is required.

## Quick start on Windows

1. Install **Node.js 22.13 or later** from [nodejs.org](https://nodejs.org/).
2. Extract this ZIP to a folder you can write to.
3. Double-click `setup.bat`. It installs the document-reading packages and creates `.env` from `.env.example`.
4. Double-click `start.bat`. The app opens at [http://localhost:3000](http://localhost:3000).

To stop the local server, close the NEXORAGPT Server window or press **Ctrl+C** in it. Start it again with `start.bat`.

## Guest workspace and saved data

The first visit creates an anonymous guest session in this browser. The session uses a random, HTTP-only browser cookie; no email or password is requested. Your chats, plugin preferences, uploaded files, and generated images remain available on this server while you use the same browser session. Clearing that browser's site data creates a new workspace, so clear the guest workspace from **Settings → Privacy** before clearing cookies if you want to permanently remove its saved data.

The guest workspace is private to its unguessable session cookie, but this build is designed for a trusted local server. Do not expose it directly to the public internet without adding appropriate deployment protections.

## Configuration

### AI Horde

The default API key `0000000000` uses anonymous access. It is free to try, but anonymous work has lower priority, shared rate limits, and may wait longer or be rejected when the public queue is busy. You can set your own AI Horde key in `AI_HORDE_API_KEY`. Free access does not mean unlimited capacity. Image generation depends on volunteer workers and can take time.

The chat API uses AI Horde's [OpenAI-compatible chat front](https://haidra-org.github.io/AI-Horde/how-to/send_chat_completions/). Image requests use the [AI Horde v2 asynchronous generation flow](https://github.com/Haidra-Org/AI-Horde/blob/main/README_integration.md). Available chat models are fetched from AI Horde and can be selected in Settings. To use a different OpenAI-compatible chat provider, set `AI_CHAT_BASE_URL` and `AI_CHAT_API_KEY`; image generation remains on AI Horde.

### Optional plugin: Translator

Set `LIBRETRANSLATE_URL` to a LibreTranslate-compatible service URL. Set `LIBRETRANSLATE_API_KEY` if that service requires a key. Translator stays unavailable until configured.

### Local settings

Change `PORT` to use a different port; also update `APP_ORIGIN` to match. `DATA_DIR` controls where SQLite, uploaded files, and generated images are stored. Back up the whole `data` folder to preserve history.

## Included features

- **AI chat:** real AI Horde responses, conversation context, saved chats, search, rename, delete, copy, retry/regenerate, model selection, loading states, and clear errors.
- **Image studio:** real AI Horde image jobs in square, landscape, portrait, or wide sizes; prompt styles; queue status; saved history; downloads.
- **File analysis:** attach images up to 5 MB, PDF, Word `.docx`, text, Markdown, CSV, and JSON files up to 8 MB. Text is extracted locally; attached content is sent to AI Horde when included in a chat request.
- **Plugins:** calculator runs locally; Weather uses Open-Meteo; Web search uses DuckDuckGo Instant Answers; Summarizer uses AI Horde; Translator uses a configured LibreTranslate server. File and code helpers open the built-in features.
- **Explore and settings:** prompt starters, display name, appearance, model selection, privacy details, and a clear-workspace action.
- **Storage:** SQLite keeps guest workspaces separate. Uploads and generated images are stored in per-session folders on this server.

## Privacy and limitations

When you ask the AI a question, the conversation context and any attached file content are sent to AI Horde community workers. Image prompts are sent to AI Horde image workers. The calculator runs locally. Weather and Web search send the location or query you enter to their named services. Avoid sharing sensitive information.

Queue times, available models, rate limits, image quality, and worker availability are controlled by AI Horde and can change. A generation may fail or remain queued. NEXORAGPT does not promise unlimited requests.

## Project layout

```text
server.js          Node.js server, API routes, SQLite, AI Horde integration
public/            Browser interface, styles, icon
data/              Created at runtime for the database, uploads, and images
.env.example       Environment variable template
setup.bat          Windows setup and dependency installation
start.bat          Windows launch script
```

## Development checks

From this folder, run:

```powershell
npm run check
```




nexoragpt.com
