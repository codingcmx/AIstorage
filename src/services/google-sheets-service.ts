// src/services/google-sheets-service.ts
'use server';

import {google, sheets_v4} from 'googleapis';
import { format } from 'date-fns';

// Environment variables for Sheets-specific service account
const GOOGLE_SHEETS_SERVICE_ACCOUNT_CLIENT_EMAIL =
  process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_CLIENT_EMAIL;
const GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY =
  process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');

// Environment variables for Calendar-specific service account (kept separate as per last change)
// These are not used in this file but are part of the overall multi-credential setup.

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

let sheets: sheets_v4.Sheets | null = null;

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (sheets) {
    return sheets;
  }
  if (
    !GOOGLE_SHEETS_SERVICE_ACCOUNT_CLIENT_EMAIL ||
    !GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY ||
    !GOOGLE_SHEET_ID
  ) {
    const errorMsg = 'Google Sheets API credentials (client email, private key for sheets) or Sheet ID are not set. Google Sheets service will not function.';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_SHEETS_SERVICE_ACCOUNT_CLIENT_EMAIL,
      private_key: GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheets = google.sheets({version: 'v4', auth});
  return sheets;
}

export interface AppointmentData {
  id: string; // Unique ID for the appointment (e.g., WhatsApp message ID or generated UUID)
  patientName: string;
  phoneNumber: string;
  appointmentDate: string; // "YYYY-MM-DD"
  appointmentTime: string; // "HH:MM" (24-hour)
  reason: string;
  status: 'booked' | 'cancelled' | 'rescheduled' | 'completed' | 'pending_confirmation';
  calendarEventId?: string; // Google Calendar Event ID
  notes?: string;
  rowIndex?: number; // For internal use to update rows easily
}

const SHEET_NAME = 'Appointments';
const HEADER_ROW = [
  'ID',
  'Patient Name',
  'Phone Number',
  'Appointment Date',
  'Appointment Time',
  'Reason',
  'Status',
  'Calendar Event ID',
  'Notes',
];

/**
 * Ensures the sheet exists and has a header row.
 */
async function ensureSheetAndHeader() {
  const client = await getSheetsClient();
  try {
    // Check if sheet exists
    const spreadsheet = await client.spreadsheets.get({
        spreadsheetId: GOOGLE_SHEET_ID!,
        ranges: [`${SHEET_NAME}!A1`], // Check a cell in the sheet
        fields: 'sheets.properties.title',
    });

    let sheetExists = false;
    if (spreadsheet.data.sheets) {
        for (const sheet of spreadsheet.data.sheets) {
            if (sheet.properties?.title === SHEET_NAME) {
                sheetExists = true;
                break;
            }
        }
    }

    if (!sheetExists) {
        console.log(`Sheet "${SHEET_NAME}" not found, creating it.`);
        await client.spreadsheets.batchUpdate({
            spreadsheetId: GOOGLE_SHEET_ID!,
            requestBody: {
                requests: [
                    { addSheet: { properties: { title: SHEET_NAME } } }
                ]
            }
        });
    }
    
    // Check header row
    const getResponse = await client.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID!,
      range: `${SHEET_NAME}!A1:I1`,
    });

    if (!getResponse.data.values || getResponse.data.values.length === 0 || 
        JSON.stringify(getResponse.data.values[0]) !== JSON.stringify(HEADER_ROW)) {
      console.log('Header row missing or incorrect, creating/updating it.');
      await client.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID!,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [HEADER_ROW],
        },
      });
      console.log('Header row created/updated in Google Sheet.');
    }
  } catch (error: any) {
    if (error.message && error.message.includes('Unable to parse range')) {
        // This can happen if the sheet truly doesn't exist. The addSheet request should handle it.
        console.warn(`Sheet "${SHEET_NAME}" might not exist initially. Attempting creation.`);
         await client.spreadsheets.batchUpdate({ // Try creating sheet again just in case.
            spreadsheetId: GOOGLE_SHEET_ID!,
            requestBody: {
                requests: [
                    { addSheet: { properties: { title: SHEET_NAME } } }
                ]
            }
        });
        // Then try to add header again
         await client.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID!,
            range: `${SHEET_NAME}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
            values: [HEADER_ROW],
            },
        });
        console.log('Header row created after sheet creation.');

    } else {
        console.error('Error ensuring sheet and header row:', error);
        throw error; // Re-throw other errors
    }
  }
}

/**
 * Adds a new appointment to the Google Sheet.
 * @param appointmentData The data for the new appointment.
 * @returns The added appointment data with its row index.
 */
export async function addAppointmentToSheet(
  appointmentData: Omit<AppointmentData, 'rowIndex'>
): Promise<AppointmentData> {
  await ensureSheetAndHeader();
  const client = await getSheetsClient();
  const row = [
    appointmentData.id,
    appointmentData.patientName,
    appointmentData.phoneNumber,
    appointmentData.appointmentDate, // Should be YYYY-MM-DD
    appointmentData.appointmentTime, // Should be HH:MM
    appointmentData.reason,
    appointmentData.status,
    appointmentData.calendarEventId || '',
    appointmentData.notes || '',
  ];
  try {
    const response = await client.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID!,
      range: `${SHEET_NAME}!A:I`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row],
      },
    });
    console.log('[Google Sheets Service] Appointment added to sheet:', response.data);
    // Determine the row index of the newly added row
    const updatedRange = response.data.updates?.updatedRange; // e.g., 'Appointments!A10:I10'
    let rowIndex;
    if (updatedRange) {
        const match = updatedRange.match(/!A(\d+):/);
        if (match && match[1]) {
            rowIndex = parseInt(match[1], 10);
        }
    }
    return { ...appointmentData, rowIndex };
  } catch (error) {
    console.error('[Google Sheets Service] Error adding appointment to Google Sheet:', error);
    throw error;
  }
}

/**
 * Fetches appointments from the Google Sheet, optionally filtered by date and/or status.
 * @param filter Optional filters for date and status.
 * @returns An array of appointment data.
 */
export async function getAppointmentsFromSheet(filter?: {
  date?: string; // YYYY-MM-DD
  status?: AppointmentData['status'] | Array<AppointmentData['status']>;
  patientName?: string;
  phoneNumber?: string;
}): Promise<AppointmentData[]> {
  await ensureSheetAndHeader();
  const client = await getSheetsClient();
  try {
    const response = await client.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID!,
      range: `${SHEET_NAME}!A2:I`, // Start from A2 to skip header
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('[Google Sheets Service] No appointments found in sheet or sheet is empty after header.');
      return [];
    }
    let appointments: AppointmentData[] = rows.map((row: any[], index: number) => ({
      id: row[0] || '',
      patientName: row[1] || '',
      phoneNumber: row[2] || '',
      appointmentDate: row[3] || '',
      appointmentTime: row[4] || '',
      reason: row[5] || '',
      status: (row[6] || 'unknown') as AppointmentData['status'],
      calendarEventId: row[7] || '',
      notes: row[8] || '',
      rowIndex: index + 2, // +2 because sheet is 1-indexed and we skip header
    }));

    if (filter) {
      if (filter.date) {
        appointments = appointments.filter(app => app.appointmentDate === filter.date);
      }
      if (filter.status) {
        const statusesToFilter = Array.isArray(filter.status) ? filter.status : [filter.status];
        appointments = appointments.filter(app => statusesToFilter.includes(app.status));
      }
      if (filter.patientName) {
        appointments = appointments.filter(app => app.patientName.toLowerCase().includes(filter.patientName!.toLowerCase()));
      }
      if (filter.phoneNumber) {
        appointments = appointments.filter(app => app.phoneNumber === filter.phoneNumber);
      }
    }
    console.log(`[Google Sheets Service] Found ${appointments.length} appointments matching filter:`, filter);
    return appointments;
  } catch (error) {
    console.error('[Google Sheets Service] Error fetching appointments from Google Sheet:', error);
    throw error;
  }
}


/**
 * Updates an existing appointment in the Google Sheet by its row index.
 * @param rowIndex The 1-based index of the row to update.
 * @param updates Partial data to update for the appointment.
 * @returns True if successful.
 */
export async function updateAppointmentInSheet(
  rowIndex: number,
  updates: Partial<Omit<AppointmentData, 'id' | 'rowIndex' | 'phoneNumber'>> // ID and phone number shouldn't typically change this way
): Promise<boolean> {
  if (!rowIndex) {
    console.error('[Google Sheets Service] Cannot update appointment without rowIndex.');
    return false;
  }
  await ensureSheetAndHeader();
  const client = await getSheetsClient();

  // Fetch the current row to only update specified fields
  const existingRowResponse = await client.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID!,
    range: `${SHEET_NAME}!A${rowIndex}:I${rowIndex}`,
  });

  if (!existingRowResponse.data.values || existingRowResponse.data.values.length === 0) {
    console.error(`[Google Sheets Service] Row ${rowIndex} not found for update.`);
    return false;
  }

  const existingRow = existingRowResponse.data.values[0];
  const updatedRow = [...existingRow]; // Create a copy

  // Update fields based on HEADER_ROW mapping
  if (updates.patientName !== undefined) updatedRow[HEADER_ROW.indexOf('Patient Name')] = updates.patientName;
  if (updates.appointmentDate !== undefined) updatedRow[HEADER_ROW.indexOf('Appointment Date')] = updates.appointmentDate;
  if (updates.appointmentTime !== undefined) updatedRow[HEADER_ROW.indexOf('Appointment Time')] = updates.appointmentTime;
  if (updates.reason !== undefined) updatedRow[HEADER_ROW.indexOf('Reason')] = updates.reason;
  if (updates.status !== undefined) updatedRow[HEADER_ROW.indexOf('Status')] = updates.status;
  if (updates.calendarEventId !== undefined) updatedRow[HEADER_ROW.indexOf('Calendar Event ID')] = updates.calendarEventId;
  if (updates.notes !== undefined) updatedRow[HEADER_ROW.indexOf('Notes')] = updates.notes;


  try {
    await client.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID!,
      range: `${SHEET_NAME}!A${rowIndex}:I${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [updatedRow],
      },
    });
    console.log(`[Google Sheets Service] Appointment in row ${rowIndex} updated in sheet.`);
    return true;
  } catch (error) {
    console.error(`[Google Sheets Service] Error updating appointment in row ${rowIndex} in Google Sheet:`, error);
    throw error;
  }
}

/**
 * Finds a specific appointment based on criteria.
 * Primarily used to find an appointment to update or cancel.
 * Returns the first match after sorting by latest date/time if multiple are found.
 */
export async function findAppointment(criteria: {
  patientName?: string;
  date?: string; // YYYY-MM-DD
  phoneNumber?: string; // For patient-initiated actions
  id?: string; // Appointment ID
  status?: AppointmentData['status'] | Array<AppointmentData['status']>; // Often 'booked' or 'pending_confirmation'
}): Promise<AppointmentData | null> {
    const appointments = await getAppointmentsFromSheet({
        date: criteria.date,
        patientName: criteria.patientName,
        phoneNumber: criteria.phoneNumber,
        status: criteria.status || ['booked', 'pending_confirmation', 'rescheduled'] // search active appts by default
    });

    if (criteria.id) {
        const foundById = appointments.find(app => app.id === criteria.id);
        console.log(`[Google Sheets Service] findAppointment by ID "${criteria.id}": ${foundById ? 'Found' : 'Not found'}`);
        return foundById || null;
    }
    
    if (appointments.length > 0) {
        // Sort by date and time, latest first, to get the most recent relevant appointment
        const sortedAppointments = appointments.sort((a, b) => {
          const dateA = new Date(`${a.appointmentDate}T${a.appointmentTime || '00:00'}`);
          const dateB = new Date(`${b.appointmentDate}T${b.appointmentTime || '00:00'}`);
          return dateB.getTime() - dateA.getTime(); // Sort descending (latest first)
        });
        console.log(`[Google Sheets Service] findAppointment by other criteria found ${sortedAppointments.length} matches, returning latest:`, sortedAppointments[0]);
        return sortedAppointments[0]; // Return the latest appointment
    }
    
    console.log('[Google Sheets Service] findAppointment found no matches for criteria:', criteria);
    return null; // No appointment found matching criteria
}
