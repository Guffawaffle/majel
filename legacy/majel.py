#!/usr/bin/env python3
"""
Majel — STFC Fleet Intelligence System
Named in honor of Majel Barrett-Roddenberry (1932–2008),
the voice of Starfleet computers across four decades of Star Trek.

Brute-force context injection with Gemini 2.5 Flash-Lite
"""
import os
import csv
import io
import google.generativeai as genai
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# --- CONFIGURATION ---
# Create this in Google Cloud Console -> APIs & Services -> Credentials
CLIENT_SECRETS_FILE = 'credentials.json'
SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly']

# The ID from your browser URL: docs.google.com/spreadsheets/d/[THIS-ID]/edit
SPREADSHEET_ID = os.environ.get('MAJEL_SPREADSHEET_ID', 'YOUR_SPREADSHEET_ID_HERE')
RANGE_NAME = os.environ.get('MAJEL_SHEET_RANGE', 'Sheet1!A1:Z1000')

# Gemini API Key (from env or fallback)
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', 'YOUR_GEMINI_API_KEY')


def get_sheets_service():
    """OAuth flow with token caching."""
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRETS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)

        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    return build('sheets', 'v4', credentials=creds)


def fetch_roster_context() -> str:
    """Fetch spreadsheet and serialize to proper CSV."""
    service = get_sheets_service()
    sheet = service.spreadsheets()
    result = sheet.values().get(spreadsheetId=SPREADSHEET_ID, range=RANGE_NAME).execute()
    values = result.get('values', [])

    if not values:
        return "No data found in spreadsheet."

    # Use csv.writer to handle commas/quotes correctly
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerows(values)
    return output.getvalue()


def build_system_prompt(roster_csv: str) -> str:
    """Construct the strict system prompt."""
    return f"""You are Majel, the Fleet Intelligence System for Admiral Guff.

DATA SOURCE:
You have access to a specific dataset of Star Trek Fleet Command officers provided below in CSV format.

RULES:
1. TRUTH: Use ONLY the provided CSV data to answer questions about officers.
2. UNKNOWN: If the answer is not in the CSV, state "Data not available in current roster." Do not guess based on external Star Trek lore.
3. CITATION: When providing stats or details, cite the spreadsheet Row Number (if available) or the specific Officer Name to verify the source.
4. DETERMINISM: Be concise and factual. No fluff.

--- BEGIN ROSTER DATA ---
{roster_csv}
--- END ROSTER DATA ---
"""


def main():
    print("⚡ Majel initializing... Connecting to Starfleet Database (Google Sheets)...")

    try:
        roster_csv = fetch_roster_context()
        print(f"✅ Roster loaded ({len(roster_csv):,} chars). Initializing neural interface...")
    except FileNotFoundError:
        print("❌ credentials.json not found.")
        print("   Download from: Google Cloud Console -> APIs & Services -> Credentials")
        print("   Place in this directory and run again.")
        return
    except Exception as e:
        print(f"❌ Failed to fetch roster: {e}")
        return

    genai.configure(api_key=GEMINI_API_KEY)

    model = genai.GenerativeModel(
        model_name='gemini-2.5-flash-lite',
        system_instruction=build_system_prompt(roster_csv)
    )

    chat = model.start_chat(history=[])

    print("\n🖖 Majel online. Awaiting input. (Type 'exit' to quit)\n")

    while True:
        try:
            user_input = input("Admiral > ").strip()
            if not user_input:
                continue
            if user_input.lower() in ['exit', 'quit', 'q']:
                print("Majel offline. Live long and prosper. 🖖")
                break

            response = chat.send_message(user_input)
            print(f"\nMajel > {response.text}\n")

        except KeyboardInterrupt:
            print("\n\nMajel offline. Live long and prosper. 🖖")
            break
        except Exception as e:
            print(f"\n⚠️ Error: {e}\n")


if __name__ == '__main__':
    main()
