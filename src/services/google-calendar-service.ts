// src/services/google-calendar-service.ts
'use server';

import {google, calendar_v3} from 'googleapis';

const GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'); // Important for .env
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

let calendar: calendar_v3.Calendar | null = null;

function getCalendarClient(): calendar_v3.Calendar {
  if (calendar) {
    return calendar;
  }
  if (
    !GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL ||
    !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  ) {
    console.error(
      'Google Calendar API credentials are not set. Service will not function.'
    );
    throw new Error('Google Calendar API credentials not configured.');
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
  summary: string; // e.g., "Appointment with John Doe"
  description: string; // e.g., "Reason: Tooth Cleaning"
  startTime: string; // ISO string, e.g., "2024-07-10T14:00:00-07:00"
  endTime: string; // ISO string, e.g., "2024-07-10T15:00:00-07:00"
  attendees?: string[]; // Array of attendee email addresses (optional for this use case)
  timezone?: string; // e.g., "America/Los_Angeles". Defaults to calendar's timezone if not set.
}

/**
 * Creates a new event in Google Calendar.
 * @param eventArgs The details for the calendar event.
 * @returns The created calendar event.
 */
export async function createCalendarEvent(
  eventArgs: CalendarEventArgs
): Promise<calendar_v3.Schema$Event> {
  const client = getCalendarClient();
  const event: calendar_v3.Schema$Event = {
    summary: eventArgs.summary,
    description: eventArgs.description,
    start: {
      dateTime: eventArgs.startTime,
      timeZone: eventArgs.timezone || (await client.calendars.get({calendarId: GOOGLE_CALENDAR_ID!})).data.timeZone || 'UTC',
    },
    end: {
      dateTime: eventArgs.endTime,
      timeZone: eventArgs.timezone || (await client.calendars.get({calendarId: GOOGLE_CALENDAR_ID!})).data.timeZone || 'UTC',
    },
  };

  if (eventArgs.attendees) {
    event.attendees = eventArgs.attendees.map(email => ({email}));
  }

  try {
    const response = await client.events.insert({
      calendarId: GOOGLE_CALENDAR_ID!,
      requestBody: event,
    });
    console.log('Event created in Google Calendar:', response.data);
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
  const client = getCalendarClient();
  const timeMin = new Date(date);
  timeMin.setHours(0, 0, 0, 0); // Start of the day

  const timeMax = new Date(date);
  timeMax.setHours(23, 59, 59, 999); // End of the day

  try {
    const response = await client.events.list({
      calendarId: GOOGLE_CALENDAR_ID!,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = response.data.items;
    return events || [];
  } catch (error) {
    console.error('Error fetching events from Google Calendar:', error);
    throw error;
  }
}


// TODO: Implement functions for updating and deleting calendar events.
// - Updating an event: `calendar.events.update({ calendarId, eventId, requestBody })`
// - Deleting an event: `calendar.events.delete({ calendarId, eventId })`
// You'll need the `eventId` which is returned when creating an event.
