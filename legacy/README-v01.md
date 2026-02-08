# Majel — STFC Fleet Intelligence System

*Named in honor of Majel Barrett-Roddenberry (1932–2008), the voice of Starfleet computers across four decades of Star Trek.*

Local Python chat interface for querying Star Trek Fleet Command roster data via Gemini 2.5 Flash-Lite.

## Setup

### 1. Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable **Google Sheets API**
4. Go to **APIs & Services → Credentials**
5. Create **OAuth 2.0 Client ID** (Desktop app type)
6. Download the JSON and save as `credentials.json` in this directory

### 2. Gemini API Key

1. Go to [AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Set environment variable:
   ```bash
   export GEMINI_API_KEY="your-key-here"
   ```

### 3. Spreadsheet ID

Get your spreadsheet ID from the URL:
```
https://docs.google.com/spreadsheets/d/[THIS-IS-YOUR-ID]/edit
```

Set it:
```bash
export MAJEL_SPREADSHEET_ID="your-spreadsheet-id"
```

### 4. Install & Run

```bash
# Activate venv
source .venv/bin/activate

# Install deps
pip install -r requirements.txt

# Run
python majel.py
```

First run will open a browser for OAuth consent. After that, token is cached.

## Files

| File | Purpose |
|------|---------|
| `majel.py` | Main script |
| `credentials.json` | OAuth client (from Google Console) — **DO NOT COMMIT** |
| `token.json` | Cached OAuth token (auto-generated) — **DO NOT COMMIT** |
| `requirements.txt` | Python dependencies |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Gemini API key | Required |
| `MAJEL_SPREADSHEET_ID` | Google Sheets ID | Required |
| `MAJEL_SHEET_RANGE` | Cell range to fetch | `Sheet1!A1:Z1000` |
