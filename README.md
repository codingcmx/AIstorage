# Firebase Studio - MediMate AI

This is a NextJS project for MediMate AI, a WhatsApp-based AI assistant for doctors.

The primary interaction for this application is via WhatsApp. The Next.js application provides the backend API endpoints (webhooks) for WhatsApp to communicate with, and Genkit flows to process messages and interact with Google services.

## Project Setup

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Set up Environment Variables:**
    Create a `.env` file in the root of your project by copying the content from `.env.example` (if it exists) or by creating a new file. Fill in the following values:

    *   **`GOOGLE_API_KEY`**: Your API key for Google AI (Gemini) used by Genkit.
        *   **How to obtain:** Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
        *   Click on "**Create API key in new project**" or select an existing project and create/get an API key.
        *   This key is specifically for accessing Gemini models through Genkit.
        *   **This is different from the Google Cloud service account credentials below.**

    *   **`WHATSAPP_VERIFY_TOKEN`**: A secret string you create. This token is used by Meta to verify that webhook requests are genuinely from your WhatsApp Business API setup.
        *   You define this token yourself (e.g., a strong random string). You will enter this same token in your Meta App Dashboard when setting up the webhook.

    *   **`WHATSAPP_ACCESS_TOKEN`**: Your WhatsApp Business API access token.
        *   Obtain from your Meta App Dashboard under "WhatsApp" > "API Setup". This is a temporary token by default; for production, you should generate a permanent System User Access Token.

    *   **`WHATSAPP_PHONE_NUMBER_ID`**: The Phone Number ID associated with your WhatsApp Business API sender number.
        *   Obtain from your Meta App Dashboard under "WhatsApp" > "API Setup".

    *   **`DOCTOR_WHATSAPP_NUMBER`**: The doctor's WhatsApp number (e.g., 15551234567, no '+' or '00') to receive daily summaries.

    *   **`GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL`**: The client email address from your Google Cloud service account JSON key file. This is for **Google Sheets and Google Calendar access**.
        *   Create a service account in the [Google Cloud Console](https://console.cloud.google.com/) for your project.
        *   Enable the "Google Sheets API" and "Google Calendar API" for that project.
        *   Download the JSON key file for the service account. This email will be in that file.

    *   **`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`**: The private key from your Google Cloud service account JSON key file. This is for **Google Sheets and Google Calendar access**.
        *   This is also found in the JSON key file.
        *   **Important**: When pasting into the `.env` file, ensure the newlines (`\n`) are preserved. It should look like:
            ```
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY_LINE_1\nYOUR_KEY_LINE_2\n...\n-----END PRIVATE KEY-----\n"
            ```

    *   **`GOOGLE_PROJECT_ID`**: Your Google Cloud Project ID (associated with the service account for Sheets/Calendar).
        *   Find this in the [Google Cloud Console](https://console.cloud.google.com/) dashboard for your project.

    *   **`GOOGLE_SHEET_ID`**: The ID of the Google Sheet where appointment data will be logged.
        *   Create a new Google Sheet. The ID is the long string in the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_IS_HERE/edit`.
        *   Ensure your service account (identified by `GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL`) has editor access to this sheet. The sheet should be named "Appointments" or the service will create it with the necessary headers.

    *   **`GOOGLE_CALENDAR_ID`**: The ID of the Google Calendar to manage appointments.
        *   For the primary calendar, this is usually `primary`.
        *   For other calendars, find the Calendar ID in Google Calendar settings.
        *   Ensure your service account has permission to manage events on this calendar (usually "Make changes to events" or "Make changes AND manage sharing").

    *   **`CRON_SECRET`** (Optional): A secret string you create to help secure your daily summary cron endpoint. If set, your cron job must send this in the `Authorization: Bearer YOUR_CRON_SECRET` header.

3.  **Run the development server for the API & Webhooks:**
    ```bash
    npm run dev
    ```
    This will start the Next.js app, typically on `http://localhost:9002`.
    *   The WhatsApp webhook will be available at `http://localhost:9002/api/whatsapp/webhook`. For Meta to reach this during development, you'll need to use a tunneling service like ngrok.
    *   The daily summary cron endpoint will be at `http://localhost:9002/api/cron/daily-summary`.

4.  **Run the Genkit development server (in a separate terminal - optional for debugging flows):**
    ```bash
    npm run genkit:dev
    ```
    This starts the Genkit developer UI, usually on `http://localhost:4000`.

## Key Components

*   **WhatsApp Webhook**: `src/app/api/whatsapp/webhook/route.ts` - Receives and processes incoming messages from WhatsApp.
*   **Daily Summary Cron Endpoint**: `src/app/api/cron/daily-summary/route.ts` - Endpoint to be triggered by a cron job to send daily summaries.
*   **AI Flows (Genkit)**: `src/ai/flows/` - Contains the logic for intent recognition, message processing, and summaries.
    *   `intent-recognition.ts`: Understands user messages (uses Gemini).
    *   `daily-summary.ts`: Generates daily appointment summaries (uses Gemini).
    *   `process-whatsapp-message-flow.ts`: Orchestrates WhatsApp message handling, booking, cancellations, etc. (uses Gemini for intent and fallback responses).
*   **Services**: `src/services/` - Modules for interacting with external APIs.
    *   `whatsapp-service.ts`: For sending messages via WhatsApp API.
    *   `google-sheets-service.ts`: For reading/writing to Google Sheets.
    *   `google-calendar-service.ts`: For managing Google Calendar events.
*   **Web UI (Optional Admin/Testing)**: `src/app/page.tsx` and `src/components/` - The existing chat interface can be used for testing intents locally (it also uses Gemini via `handleUserMessage`) but is not part of the core patient-facing product.

## Deployment

For production, deploy your Next.js application to a platform like Vercel or Firebase App Hosting.
*   Use the deployed URL for your WhatsApp webhook (e.g., `https://your-app-url.com/api/whatsapp/webhook`).
*   Remember to set up all your environment variables in your deployment platform's settings.
*   Configure a cron job (e.g., Vercel Cron Jobs, GitHub Actions, or a third-party service) to call the `https://your-app-url.com/api/cron/daily-summary` endpoint daily at your desired time (e.g., 7 AM).
```