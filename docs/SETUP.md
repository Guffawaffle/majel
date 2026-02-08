# Majel — Developer Setup Guide

Step-by-step setup for all Majel dependencies. You'll need about 5 minutes.

---

## 1. Gemini API Key (Required — 60 seconds)

The AI engine. Free tier works fine for personal use.

### Steps

1. Go to **[Google AI Studio → API Keys](https://aistudio.google.com/apikey)**
2. Sign in with your Google account
3. Click **"Create API key"**
4. If prompted, select your existing project (e.g., "Majel") or create one
5. Copy the key (starts with `AIzaSy...`)
6. Open `/srv/majel/.env` and paste it:

```env
GEMINI_API_KEY=AIzaSy...your-key-here
```

### Verify

```bash
# Quick test (replace with your key)
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY" | head -5
```

If you see JSON with model names, the key works.

### Cost

Gemini 2.5 Flash-Lite: ~$0.075 per million input tokens. A typical session with a 500-row roster uses ~30K tokens = **less than $0.01 per session**.

---

## 2. Google Sheets OAuth (Optional — 5 minutes)

This connects Majel to your STFC roster spreadsheet. **Skip this if you just want to test chat** — Majel works without it.

### The Big Picture

You need three things:
- **A Google Cloud project** with the Sheets API enabled
- **An OAuth client** (a `credentials.json` file)
- **Your spreadsheet ID** from the URL

### Step-by-Step

#### 2a. Enable the Google Sheets API

1. Go to **[Google Cloud Console → APIs & Services](https://console.cloud.google.com/apis/dashboard)**
2. Select your project (if you created "Majel" in AI Studio, it should already exist — look for project ID `375180256352` or whatever yours is)
3. Click **"+ ENABLE APIS AND SERVICES"** at the top
4. Search for **"Google Sheets API"**
5. Click it → Click **"Enable"**

#### 2b. Configure the OAuth Consent Screen

> **You must do this before creating credentials.** It only takes a minute.

1. In the left sidebar, click **[OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)**
2. If prompted for user type, select **"External"** → Click **Create**
3. Fill in:
   - **App name:** `Majel`
   - **User support email:** your email
   - **Developer contact email:** your email
4. Click **"Save and Continue"**
5. **Scopes** — click "Add or Remove Scopes", search for `spreadsheets.readonly`, check it, click **Update** → **Save and Continue**
6. **Test users** — click **"Add Users"**, add your Google email → **Save and Continue**
7. Click **"Back to Dashboard"**

#### 2c. Create the OAuth Client ID

1. In the left sidebar, click **[Credentials](https://console.cloud.google.com/apis/credentials)**
2. Click **"+ CREATE CREDENTIALS"** at the top
3. Select **"OAuth client ID"**
4. **Application type:** Select **"Desktop app"**
5. **Name:** `Majel` (or anything)
6. Click **"Create"**
7. A dialog shows your Client ID and Secret — click **"DOWNLOAD JSON"**
8. Save the file as **`credentials.json`** in `/srv/majel/`

```bash
# Move it to the right place
mv ~/Downloads/client_secret_*.json /srv/majel/credentials.json
```

#### 2d. Get Your Spreadsheet ID

Your spreadsheet URL looks like:
```
https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit
                                       └──────── THIS PART ────────┘
```

Copy that ID and add it to `.env`:
```env
MAJEL_SPREADSHEET_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
MAJEL_SHEET_RANGE=Sheet1!A1:Z1000
```

#### 2e. First Run — OAuth Consent

When you start Majel with Sheets configured, it will print:
```
🔐 OAuth required. Open this URL in a browser:
   https://accounts.google.com/o/oauth2/auth?...
```

1. Open that URL
2. Sign in with the same Google account
3. Click through "This app isn't verified" → "Continue" (it's your own app)
4. Grant read-only access to Sheets
5. You'll see "✅ Majel authorized!" — close the tab
6. A `token.json` is cached — you won't need to do this again

---

## 3. Configure .env

Your final `.env` should look like this:

```env
# === ISOLATION (Lex uses its own DB, not your global one) ===
LEX_WORKSPACE_ROOT=/srv/majel

# === Gemini (Required) ===
GEMINI_API_KEY=AIzaSy...your-actual-key

# === Google Sheets (Optional) ===
MAJEL_SPREADSHEET_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
MAJEL_SHEET_RANGE=Sheet1!A1:Z1000

# === Server ===
MAJEL_PORT=3000
```

---

## 4. Run

```bash
cd /srv/majel
npm run dev
```

Open http://localhost:3000 — you should see the chat interface.

---

## Troubleshooting

### "credentials.json not found"
Download the OAuth client JSON from [Google Cloud → Credentials](https://console.cloud.google.com/apis/credentials) and save it as `/srv/majel/credentials.json`.

### OAuth says "This app isn't verified"
Expected — it's your personal app. Click "Advanced" → "Go to Majel (unsafe)". This is safe since you own the OAuth client.

### "Access blocked: This app's request is invalid"
The OAuth consent screen redirect URI doesn't match. Make sure your OAuth client type is **"Desktop app"**, not "Web application".

### Roster loads but shows "No data found"
Check `MAJEL_SHEET_RANGE` — the default `Sheet1!A1:Z1000` assumes your data is on the first sheet. Adjust if your sheet has a different name.

### Token expired
Delete `token.json` and restart — Majel will re-run the OAuth flow.
```bash
rm /srv/majel/token.json
npm run dev
```
