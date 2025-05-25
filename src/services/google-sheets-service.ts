// src/services/google-sheets-service.ts
'use server';

import {google} from 'googleapis';

const GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY =
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'); // Important for .env
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

let sheets: ReturnType<typeof google.sheets> | null = null;

function getSheetsClient() {
  if (sheets) {
    return sheets;
  }
  if (
    !GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL ||
    !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    !GOOGLE_SHEET_ID
  ) {
    console.error(
      'Google Sheets API credentials or Sheet ID are not set. Service will not function.'
    );
    throw new Error(
      'Google Sheets API credentials or Sheet ID not configured.'
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL,
      private_key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheets = google.sheets({version: 'v4', auth});
  return sheets;
}

export interface AppointmentData {
  id?: string; // Optional, can be auto-generated or a WhatsApp message ID
  patientName: string;
  phoneNumber: string;
  appointmentDate: string; // e.g., "2024-07-10"
  appointmentTime: string; // e.g., "14:00"
  reason: string;
  status: 'booked' | 'cancelled' | 'rescheduled' | 'completed';
  notes?: string;
}

const SHEET_NAME = 'Appointments'; // Or make this configurable

/**
 * Ensures the sheet has a header row.
 */
async function ensureHeaderRow() {
  const client = getSheetsClient();
  try {
    const getResponse = await client.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_NAME}!A1:G1`,
    });
    if (!getResponse.data.values || getResponse.data.values.length === 0) {
      const header = [
        'ID',
        'Patient Name',
        'Phone Number',
        'Appointment Date',
        'Appointment Time',
        'Reason',
        'Status',
        'Notes',
      ];
      await client.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [header],
        },
      });
      console.log('Header row created in Google Sheet.');
    }
  } catch (error) {
    console.error('Error ensuring header row:', error);
    // If sheet doesn't exist, this might fail. Consider creating sheet if not exists.
  }
}

/**
 * Adds a new appointment to the Google Sheet.
 * @param appointmentData The data for the new appointment.
 * @returns The result of the append operation.
 */
export async function addAppointmentToSheet(appointmentData: AppointmentData) {
  await ensureHeaderRow(); // Make sure header exists
  const client = getSheetsClient();
  const row = [
    appointmentData.id || new Date().toISOString(), // Use ISO string as a simple unique ID if not provided
    appointmentData.patientName,
    appointmentData.phoneNumber,
    appointmentData.appointmentDate,
    appointmentData.appointmentTime,
    appointmentData.reason,
    appointmentData.status,
    appointmentData.notes || '',
  ];
  try {
    const response = await client.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_NAME}!A:H`, // Append to the first 8 columns
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });
    console.log('Appointment added to sheet:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error adding appointment to Google Sheet:', error);
    throw error;
  }
}

/**
 * Fetches all appointments from the Google Sheet.
 * (This is a basic example; you might want more sophisticated querying)
 * @returns An array of appointment data.
 */
export async function getAppointmentsFromSheet(date?: string): Promise<AppointmentData[]> {
  await ensureHeaderRow();
  const client = getSheetsClient();
  try {
    const response = await client.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_NAME}!A2:H`, // Start from A2 to skip header
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return [];
    }
    const appointments: AppointmentData[] = rows.map((row: any[]) => ({
      id: row[0],
      patientName: row[1],
      phoneNumber: row[2],
      appointmentDate: row[3],
      appointmentTime: row[4],
      reason: row[5],
      status: row[6] as AppointmentData['status'],
      notes: row[7],
    }));

    if (date) {
        return appointments.filter(app => app.appointmentDate === date && app.status === 'booked');
    }

    return appointments;
  } catch (error) {
    console.error('Error fetching appointments from Google Sheet:', error);
    throw error;
  }
}

// TODO: Implement functions for updating (reschedule, cancel) and deleting appointments.
// This would involve finding the row (e.g., by ID or patient name + date) and then updating its values.
// For example, to update status:
// 1. Find row index.
// 2. Use `sheets.spreadsheets.values.update` with the specific range like `${SHEET_NAME}!G${rowIndex}`.
