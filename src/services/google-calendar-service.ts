
// src/services/google-calendar-service.ts
'use server';

import {google, calendar_v3} from 'googleapis';

const GOOGLE_CALENDAR_SERVICE_ACCOUNT_CLIENT_EMAIL =
  process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_CLIENT_EMAIL;
const GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY =
  process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

let calendar: calendar_v3.Calendar | null = null;

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  if (calendar) {
    return calendar;
  }
  if (
    !GOOGLE_CALENDAR_SERVICE_ACCOUNT_CLIENT_EMAIL ||
    !GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY
  ) {
    const errorMsg = 'Google Calendar API credentials (client email, private key) are not set. Service will not function.';
    console.error(`[Google Calendar Service] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: GOOGLE_CALENDAR_SERVICE_ACCOUNT_CLIENT_EMAIL,
        private_key: GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    calendar = google.calendar({version: 'v3', auth});
    console.log('[Google Calendar Service] Calendar client initialized successfully.');
    return calendar;
  } catch (e: any) {
    const authErrorMsg = `[Google Calendar Service] Error initializing Google Calendar client: ${e.message || String(e)}`;
    console.error(authErrorMsg, e.stack);
    throw new Error(authErrorMsg);
  }
}

export interface CalendarEventArgs {
  summary: string;
  description: string;
  startTime: string; // ISO string
  endTime: string; // ISO string
  attendees?: Array<{ email: string }>;
  timezone?: string; // e.g., "America/Los_Angeles"
  guestsCanModify?: boolean;
}

let defaultTimezone: string | undefined;

async function getDefaultTimezone(client: calendar_v3.Calendar): Promise<string> {
    if (defaultTimezone) return defaultTimezone;
    try {
        console.log(`[Google Calendar Service] Fetching calendar details for calendar ID: ${GOOGLE_CALENDAR_ID}`);
        const calendarData = await client.calendars.get({ calendarId: GOOGLE_CALENDAR_ID! });
        defaultTimezone = calendarData.data.timeZone || 'UTC';
        console.log(`[Google Calendar Service] Default timezone for calendar ${GOOGLE_CALENDAR_ID} is ${defaultTimezone}`);
        return defaultTimezone;
    } catch (e: any) {
        console.warn(`[Google Calendar Service] Could not fetch default calendar timezone for ${GOOGLE_CALENDAR_ID}, defaulting to UTC. Error:`, e.message || String(e), e.stack);
        defaultTimezone = 'UTC'; // Set default so we don't keep trying and failing
        return defaultTimezone;
    }
}


/**
 * Creates a new event in Google Calendar.
 * @param eventArgs The details for the calendar event.
 * @returns The created calendar event, including its ID.
 */
export async function createCalendarEvent(
  eventArgs: CalendarEventArgs
): Promise<calendar_v3.Schema$Event> {
  const client = await getCalendarClient();
  const tz = eventArgs.timezone || await getDefaultTimezone(client);
  const event: calendar_v3.Schema$Event = {
    summary: eventArgs.summary,
    description: eventArgs.description,
    start: {
      dateTime: eventArgs.startTime,
      timeZone: tz,
    },
    end: {
      dateTime: eventArgs.endTime,
      timeZone: tz,
    },
    attendees: eventArgs.attendees,
    guestsCanModify: eventArgs.guestsCanModify === undefined ? false : eventArgs.guestsCanModify,
  };

  try {
    const response = await client.events.insert({
      calendarId: GOOGLE_CALENDAR_ID!,
      requestBody: event,
    });
    console.log('[Google Calendar Service] Event created:', response.data.id, response.data.summary);
    return response.data;
  } catch (error: any) {
    console.error('[Google Calendar Service] Error creating event:', error.message || String(error), error.stack);
    throw error;
  }
}

/**
 * Lists events from Google Calendar for a specific day.
 * @param date The date to fetch events for (YYYY-MM-DD).
 * @returns A list of calendar events.
 */
export async function getCalendarEventsForDay(date: string): Promise<calendar_v3.Schema$Event[]> {
  const client = await getCalendarClient();
  const tz = await getDefaultTimezone(client);

  const timeMinDate = new Date(`${date}T00:00:00`);
  const timeMaxDate = new Date(`${date}T23:59:59`);

  try {
    const response = await client.events.list({
      calendarId: GOOGLE_CALENDAR_ID!,
      timeMin: timeMinDate.toISOString(),
      timeMax: timeMaxDate.toISOString(),
      timeZone: tz,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = response.data.items;
    console.log(`[Google Calendar Service] Found ${events?.length || 0} events for ${date} in calendar ${GOOGLE_CALENDAR_ID}`);
    return events || [];
  } catch (error: any) {
    console.error('[Google Calendar Service] Error fetching events:', error.message || String(error), error.stack);
    throw error;
  }
}

/**
 * Updates an existing calendar event.
 * @param eventId The ID of the event to update.
 * @param updates The partial data to update the event with.
 * @returns The updated calendar event.
 */
export async function updateCalendarEvent(
  eventId: string,
  updates: Partial<CalendarEventArgs>
): Promise<calendar_v3.Schema$Event> {
  const client = await getCalendarClient();
  const tz = updates.timezone || await getDefaultTimezone(client);

  // Construct the request body carefully, only including fields to be updated
  const requestBody: calendar_v3.Schema$Event = {};
  if (updates.summary) requestBody.summary = updates.summary;
  if (updates.description) requestBody.description = updates.description;
  if (updates.startTime) requestBody.start = { dateTime: updates.startTime, timeZone: tz };
  if (updates.endTime) requestBody.end = { dateTime: updates.endTime, timeZone: tz };
  if (updates.attendees) requestBody.attendees = updates.attendees;
  if (updates.guestsCanModify !== undefined) requestBody.guestsCanModify = updates.guestsCanModify;


  if (Object.keys(requestBody).length === 0) {
    console.warn('[Google Calendar Service] Update called with no fields to update for eventId:', eventId);
    // Optionally, fetch and return the existing event if no updates are provided
    const existingEvent = await client.events.get({ calendarId: GOOGLE_CALENDAR_ID!, eventId });
    return existingEvent.data;
  }

  try {
    const response = await client.events.patch({ // Use patch for partial updates
      calendarId: GOOGLE_CALENDAR_ID!,
      eventId: eventId,
      requestBody: requestBody,
    });
    console.log('[Google Calendar Service] Event updated:', response.data.id, response.data.summary);
    return response.data;
  } catch (error: any) {
    console.error(`[Google Calendar Service] Error updating event ${eventId}:`, error.message || String(error), error.stack);
    throw error;
  }
}

/**
 * Deletes a calendar event.
 * @param eventId The ID of the event to delete.
 */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const client = await getCalendarClient();
  try {
    await client.events.delete({
      calendarId: GOOGLE_CALENDAR_ID!,
      eventId: eventId,
    });
    console.log('[Google Calendar Service] Event deleted:', eventId);
  } catch (error: any) {
    // Google Calendar API returns 410 if event is already deleted, which is not an error for us.
    // It might also return 404 if the event never existed or was deleted by another means.
    if (error.code === 410 || error.code === 404) {
      console.warn(`[Google Calendar Service] Event ${eventId} already deleted or not found. Proceeding as success.`);
    } else {
      console.error(`[Google Calendar Service] Error deleting event ${eventId}:`, error.message || String(error), error.stack);
      throw error;
    }
  }
}
    