// src/services/google-calendar-service.ts
'use server';

import {google, calendar_v3} from 'googleapis';

const GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

let calendar: calendar_v3.Calendar | null = null;

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  if (calendar) {
    return calendar;
  }
  if (
    !GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL ||
    !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  ) {
    const errorMsg = 'Google Calendar API credentials are not set. Service will not function.';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL,
      private_key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
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
        return defaultTimezone;
    } catch (e) {
        console.warn("Could not fetch default calendar timezone, defaulting to UTC", e);
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
    console.log('Event created in Google Calendar:', response.data.id, response.data.summary);
    return response.data;
  } catch (error) {
    console.error('Error creating event in Google Calendar:', error);
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

  const timeMinDate = new Date(`${date}T00:00:00`); // Assumes date is YYYY-MM-DD
  const timeMaxDate = new Date(`${date}T23:59:59`);

  // If the calendar is in a different timezone, creating ISO strings directly might be problematic
  // For simplicity, assuming dates are relative to the calendar's timezone for daily lookup.
  // More robust solution would convert local date to calendar's timezone start/end of day.

  try {
    const response = await client.events.list({
      calendarId: GOOGLE_CALENDAR_ID!,
      timeMin: timeMinDate.toISOString(), // This might need adjustment based on calendar's TZ vs server TZ
      timeMax: timeMaxDate.toISOString(), // Same as above
      timeZone: tz, // Specify the calendar's timezone for the query
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = response.data.items;
    console.log(`Found ${events?.length || 0} events for ${date} in calendar ${GOOGLE_CALENDAR_ID}`);
    return events || [];
  } catch (error) {
    console.error('Error fetching events from Google Calendar:', error);
    throw error;
  }
}

/**
 * Updates an existing calendar event.
 * @param eventId The ID of the event to update.
 * @param updates Partial CalendarEventArgs to update.
 * @returns The updated calendar event.
 */
export async function updateCalendarEvent(
  eventId: string,
  updates: Partial<CalendarEventArgs>
): Promise<calendar_v3.Schema$Event> {
  const client = await getCalendarClient();
  const tz = updates.timezone || await getDefaultTimezone(client);

  const eventPatch: Partial<calendar_v3.Schema$Event> = {};
  if (updates.summary) eventPatch.summary = updates.summary;
  if (updates.description) eventPatch.description = updates.description;
  if (updates.startTime) eventPatch.start = { dateTime: updates.startTime, timeZone: tz };
  if (updates.endTime) eventPatch.end = { dateTime: updates.endTime, timeZone: tz };
  if (updates.attendees) eventPatch.attendees = updates.attendees;


  try {
    const response = await client.events.patch({
      calendarId: GOOGLE_CALENDAR_ID!,
      eventId: eventId,
      requestBody: eventPatch,
    });
    console.log('Event updated in Google Calendar:', response.data.id, response.data.summary);
    return response.data;
  } catch (error) {
    console.error(`Error updating event ${eventId} in Google Calendar:`, error);
    throw error;
  }
}

/**
 * Deletes a calendar event.
 * @param eventId The ID of the event to delete.
 * @returns True if successful.
 */
export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const client = await getCalendarClient();
  try {
    await client.events.delete({
      calendarId: GOOGLE_CALENDAR_ID!,
      eventId: eventId,
    });
    console.log(`Event ${eventId} deleted from Google Calendar.`);
    return true;
  } catch (error) {
    console.error(`Error deleting event ${eventId} from Google Calendar:`, error);
    // It's possible the event was already deleted, GAPI might return 404 or 410 (Gone)
    if ((error as any).code === 404 || (error as any).code === 410) {
        console.warn(`Event ${eventId} not found for deletion, might have been already deleted.`);
        return true; // Consider it successful if not found
    }
    throw error;
  }
}
