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
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_CALENDAR_SERVICE_ACCOUNT_CLIENT_EMAIL,
      private_key: GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  calendar = google.calendar({version: 'v3', auth});
  return calendar;
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
        const calendarData = await client.calendars.get({ calendarId: GOOGLE_CALENDAR_ID! });
        defaultTimezone = calendarData.data.timeZone || 'UTC';
        console.log(`[Google Calendar Service] Default timezone for calendar ${GOOGLE_CALENDAR_ID} is ${defaultTimezone}`);
        return defaultTimezone;
    } catch (e) {
        console.warn(`[Google Calendar Service] Could not fetch default calendar timezone for ${GOOGLE_CALENDAR_ID}, defaulting to UTC. Error:`, e);
        return 'UTC';
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
  } catch (error) {
    console.error('[Google Calendar Service] Error creating event:', error);
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
  } catch (error) {
    console.error('[Google Calendar Service] Error fetching events:', error);
    throw error;
  }
}

/**
 * Updates an existing calendar event.
 * @param eventId The ID of the event to update.
 *
