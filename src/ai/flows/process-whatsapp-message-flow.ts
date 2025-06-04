// src/ai/flows/process-whatsapp-message-flow.ts
'use server';
/**
 * @fileOverview Processes incoming WhatsApp messages, recognizes intent,
 * performs actions (booking, rescheduling, cancelling, doctor commands),
 * interacts with Google Sheets & Calendar, and generates a response.
 *
 * - processWhatsAppMessage - Main function to handle WhatsApp messages.
 * - ProcessWhatsAppMessageInput - Input type for the flow.
 * - ProcessWhatsAppMessageOutput - Output type for the flow.
 */

import {z} from 'zod';
import {recognizeIntent, type RecognizeIntentOutput} from './intent-recognition';
import { RecognizeIntentFunctionOutputSchema } from '../schemas';
import { sendWhatsAppMessage } from '@/services/whatsapp-service';
import {
  addAppointmentToSheet,
  updateAppointmentInSheet,
  findAppointment,
  getAppointmentsFromSheet,
  type AppointmentData,
} from '@/services/google-sheets-service';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEventsForDateRange,
  type CalendarEventArgs,
} from '@/services/google-calendar-service';
import {
  format,
  parse,
  addMinutes,
  setHours,
  setMinutes,
  setSeconds,
  setMilliseconds,
  isValid,
  isFuture,
  parseISO,
  isSameDay,
  isWithinInterval,
  startOfDay,
  endOfDay,
  getHours,
  getDay,
  addDays,
  subDays,
} from 'date-fns';

// Add type declarations for process.env
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DOCTOR_WHATSAPP_NUMBER?: string;
    }
  }
}

const ProcessWhatsAppMessageInputSchema = z.object({
  senderId: z.string().describe("The sender's WhatsApp ID (phone number)."),
  senderName: z.string().optional().describe("The sender's profile name, if available."),
  messageText: z.string().describe('The text content of the WhatsApp message.'),
  messageId: z.string().describe('The ID of the incoming WhatsApp message.'),
  timestamp: z.string().describe('The timestamp of the incoming message as an ISO 8601 string.'),
});
export type ProcessWhatsAppMessageInput = z.infer<
  typeof ProcessWhatsAppMessageInputSchema
>;

const ProcessWhatsAppMessageOutputSchema = z.object({
  responseSent: z.boolean().describe('Whether a response was attempted and believed to be successful.'),
  responseText: z.string().optional().describe('The text of the response sent or planned.'),
  intentData: RecognizeIntentFunctionOutputSchema.optional().describe('Data from intent recognition.'),
  error: z.string().optional().describe('Error message if processing or sending failed.'),
});
export type ProcessWhatsAppMessageOutput = z.infer<
  typeof ProcessWhatsAppMessageOutputSchema
>;

// In-memory store for booking pause status
let isBookingPaused = false;
let pauseStartDate: Date | null = null;
let pauseEndDate: Date | null = null;

// Clinic Working Hours
const DOCTOR_WORK_START_HOUR = 9; // 9 AM
const DOCTOR_WORK_END_HOUR = 17; // 5 PM (exclusive, appointments must start before 5 PM)

// Add these constants at the top with other constants
const APPOINTMENT_DURATION_MINUTES = 45;
const BREAK_DURATION_MINUTES = 15;
const TOTAL_SLOT_DURATION = APPOINTMENT_DURATION_MINUTES + BREAK_DURATION_MINUTES;

// Add these type guards at the top
function isValidRowIndex(index: number | undefined | null): index is number {
  return typeof index === 'number' && index > 0;
}

function isValidCalendarId(id: string | undefined | null): id is string {
  return typeof id === 'string' && id.length > 0;
}

// Helper to parse date and time from entities, trying various formats
function parseDateTime(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr || !timeStr) {
    console.log(`[ParseDateTime - process-flow] Missing dateStr ('${dateStr}') or timeStr ('${timeStr}'). Returning null.`);
    return null;
  }
  console.log(`[ParseDateTime - process-flow] Attempting to parse date: "${dateStr}", time: "${timeStr}"`);

  let parsedDate: Date | null = null;

  const specificDateTimeFormats = [
    'yyyy-MM-dd HH:mm',
    'yyyy-MM-dd h:mm a',
    'yyyy-MM-dd hh:mma', 
    'yyyy-MM-dd ha',    
  ];

  for (const fmt of specificDateTimeFormats) {
    try {
      const combinedStr = `${dateStr} ${timeStr}`;
      const tempDate = parse(combinedStr, fmt, new Date());
      if (isValid(tempDate)) {
        console.log(`[ParseDateTime - process-flow] Parsed successfully with format "${fmt}":`, tempDate);
        return tempDate;
      }
    } catch (e) { /* ignore, try next format */ }
  }
  console.log(`[ParseDateTime - process-flow] Failed specific formats. Trying fallback for dateStr: "${dateStr}", timeStr: "${timeStr}"`);

  try {
    let baseDate = parseISO(dateStr); 
    if(!isValid(baseDate)) {
        baseDate = parse(dateStr, 'yyyy-MM-dd', new Date()); 
    }

    if (!isValid(baseDate)) {
        console.warn(`[ParseDateTime - process-flow] Fallback: Unparseable date string: "${dateStr}" after ISO and yyyy-MM-dd attempts.`);
        return null;
    }

    const timeMatch = (timeStr as string).match(/(\d{1,2})[:\.]?(\d{2})?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const period = timeMatch[3]?.toLowerCase();

      if (period === 'pm' && hour < 12) hour += 12;
      if (period === 'am' && hour === 12) hour = 0; 

      if (hour >= 0 && hour <= 23 && minute >=0 && minute <= 59) {
        parsedDate = setMilliseconds(setSeconds(setMinutes(setHours(baseDate, hour), minute), 0), 0);
        if (isValid(parsedDate)) {
            console.log(`[ParseDateTime - process-flow] Fallback: Parsed with regex on baseDate ${format(baseDate, 'yyyy-MM-dd')}:`, parsedDate);
            return parsedDate;
        } else {
            console.warn(`[ParseDateTime - process-flow] Fallback: Resulting date from setHours/Minutes is invalid. Base: ${baseDate}, H:${hour}, M:${minute}`);
        }
      } else {
          console.warn(`[ParseDateTime - process-flow] Fallback: Invalid hour/minute from regex: hour=${hour}, minute=${minute} for timeStr: "${timeStr}"`);
      }
    } else {
        console.warn(`[ParseDateTime - process-flow] Fallback: Time string "${timeStr}" did not match regex.`);
    }
  } catch (e) {
    console.error(`[ParseDateTime - process-flow] Fallback: Error in fallback date/time parsing for dateStr: "${dateStr}", timeStr: "${timeStr}":`, e);
  }

  console.warn(`[ParseDateTime - process-flow] Failed to parse date/time combination for date: "${dateStr}", time: "${timeStr}" using all methods. Returning null.`);
  return null;
}

// Add this helper function after other helper functions
function parseRelativeDate(dateStr: string): Date | null {
  const today = new Date();
  const lowerDateStr = dateStr.toLowerCase();
  
  if (lowerDateStr === 'today') {
    return today;
  } else if (lowerDateStr === 'tomorrow') {
    return addDays(today, 1);
  } else if (lowerDateStr === 'yesterday') {
    return subDays(today, 1);
  }
  
  return null;
}

// Add this helper function for consistent formatting
function formatDateTime(date: Date, includeTime: boolean = true): string {
  const dateStr = format(date, 'MMMM d, yyyy');
  if (!includeTime) return dateStr;
  return `${dateStr} at ${format(date, 'h a')}`;
}

// Add this helper function to combine availability and conflict checks
async function checkAvailabilityAndConflicts(date: Date, time?: string): Promise<{ 
  availableSlots: string[], 
  hasConflict: boolean, 
  conflictDetails?: any 
}> {
  const existingAppointments = await getAppointmentsFromSheet({
    date: format(date, 'yyyy-MM-dd'),
    status: ['booked', 'pending_confirmation', 'rescheduled']
  });

  const bookedBlocks = new Set(
    existingAppointments.map(app => {
      const appTime = parseDateTime(app.appointmentDate, app.appointmentTime);
      return appTime ? format(appTime, 'HH:mm') : null;
    }).filter(Boolean)
  );

  const availableSlots: string[] = [];
  let currentTime = setHours(date, DOCTOR_WORK_START_HOUR);
  const endOfDay = setHours(date, DOCTOR_WORK_END_HOUR);
  
  while (currentTime < endOfDay) {
    const timeStr = format(currentTime, 'HH:mm');
    if (!bookedBlocks.has(timeStr)) {
      availableSlots.push(format(currentTime, 'h a'));
    }
    currentTime = addMinutes(currentTime, TOTAL_SLOT_DURATION);
  }

  let hasConflict = false;
  let conflictDetails = null;

  if (time) {
    const requestedTimeStr = format(parseDateTime(format(date, 'yyyy-MM-dd'), time)!, 'HH:mm');
    if (bookedBlocks.has(requestedTimeStr)) {
      hasConflict = true;
      conflictDetails = existingAppointments.find(app => {
        const appTime = parseDateTime(app.appointmentDate, app.appointmentTime);
        return appTime && format(appTime, 'HH:mm') === requestedTimeStr;
      });
    }
  }

  return { availableSlots, hasConflict, conflictDetails };
}

// Update the isHinglishMessage function to be less sensitive
function isHinglishMessage(message: string): boolean {
  const hinglishIndicators = [
    'kya', 'hai', 'ke', 'se', 'ko', 'ka', 'ki', 'mein', 'aap', 'hum',
    'kripya', 'please', 'sorry', 'thank', 'book', 'appointment', 'time',
    'date', 'cancel', 'reschedule', 'available', 'slot', 'karna', 'chahenge', 'liye', 'hain', 'har', 'ki', 'hoti', 'uske', 'baad', 'ka', 'hota', 'kya', 'aap', 'inme', 'se', 'koi', 'book', 'karna', 'chahenge', 'ye', 'slots', 'available', 'hain', 'har', 'appointment', 'minutes', 'ki', 'hoti', 'hai', 'uske', 'baad', 'minutes', 'ka', 'break', 'hota', 'hai'
  ];
  
  const words = message.toLowerCase().split(/\s+/);
  const hinglishWordCount = words.filter(word => hinglishIndicators.includes(word)).length;
  // Increase the threshold for detecting Hinglish
  return hinglishWordCount >= 4; // Require at least 4 Hinglish indicators
}

// Add this helper function for bilingual responses
function getBilingualResponse(type: string, date1?: Date | string, date2?: Date, isHinglish: boolean = false): string {
  if (isHinglish) {
    switch(type) {
      case 'pause_booking':
        if (date1 && date2) {
          return `Sorry, ${formatDateTime(date1 as Date, false)} se ${formatDateTime(date2 as Date, false)} tak koi new appointments nahi le rahe hain. Kripya kisi aur date ke liye try karein.`;
        }
        return `Sorry, ${formatDateTime(date1 as Date, false)} ke liye koi new appointments nahi le rahe hain. Kripya kisi aur date ke liye try karein.`;
      
      case 'no_slots':
        return `Sorry, ${formatDateTime(date1 as Date, false)} ke liye koi available slots nahi hain. Kya aap kisi aur date ke liye try karna chahenge?`;
      
      case 'booking_confirmed':
        return `Great! Aapka "${date1}" ke liye appointment confirm ho gaya hai ${formatDateTime(date2 as Date, false)}`;
      
      case 'reschedule_confirmed':
        return `Aapka appointment reschedule ho gaya hai ${formatDateTime(date1 as Date, false)}`;
      
      case 'cancellation_confirmed':
        return `Aapka appointment cancel ho gaya hai`;
      
      case 'clinic_closed':
        return `Sorry, clinic weekends (${format(date1 as Date, 'EEEE')}) ko closed rehti hai. Kripya Monday se Friday ke beech koi date choose karein.`;
      
      case 'outside_hours':
        return `Sorry, ${format(date1 as Date, 'h a')} clinic hours ke bahar hai (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR - 1), 'h a')}). Kripya in hours ke andar koi time choose karein.`;
      
      default:
        return '';
    }
  } else {
    switch(type) {
      case 'pause_booking':
        if (date1 && date2) {
          return `I'm sorry, we are not accepting new bookings from ${formatDateTime(date1 as Date, false)} to ${formatDateTime(date2 as Date, false)}. Please try booking for a different date.`;
        }
        return `I'm sorry, we are not accepting new bookings for ${formatDateTime(date1 as Date, false)}. Please try booking for a different date.`;
      
      case 'no_slots':
        return `I'm sorry, there are no available appointments for ${formatDateTime(date1 as Date, false)}. Would you like to try another date?`;
      
      case 'booking_confirmed':
        return `Great! Your appointment for "${date1}" is confirmed for ${formatDateTime(date2 as Date, false)}`;
      
      case 'reschedule_confirmed':
        return `Your appointment has been rescheduled to ${formatDateTime(date1 as Date, false)}`;
      
      case 'cancellation_confirmed':
        return `Your appointment has been cancelled`;
      
      case 'clinic_closed':
        return `Sorry, the clinic is closed on weekends (${format(date1 as Date, 'EEEE')})`;
      
      case 'outside_hours':
        return `Sorry, ${format(date1 as Date, 'h a')} is outside our clinic hours (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR - 1), 'h a')})`;
      
      default:
        return '';
    }
  }
}

// Add these utility functions at the top
async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

// Add type safety for sheet operations
interface SheetOperationResult {
  success: boolean;
  rowIndex: number;
  error?: string;
}

export async function processWhatsAppMessage(
  input: ProcessWhatsAppMessageInput
): Promise<ProcessWhatsAppMessageOutput> {
  let messageReceivedDate: Date;
  try {
    messageReceivedDate = parseISO(input.timestamp);
    if (!isValid(messageReceivedDate)) {
      throw new Error(`Invalid timestamp string: ${input.timestamp}`);
    }
  } catch (e: any) {
    const timestampError = `[Process Flow - ${input.senderId}] CRITICAL: Invalid or unparseable timestamp provided: "${input.timestamp}". Error: ${e.message}. Cannot process message.`;
    console.error(timestampError);
    try {
      await sendWhatsAppMessage(input.senderId, "I'm sorry, there was a problem with the timing of your message. Please try sending it again.");
    } catch (sendErr) {
      console.error(`[Process Flow - ${input.senderId}] Failed to send timestamp error message:`, sendErr);
    }
    return {
      responseSent: false,
      responseText: "Failed due to invalid message timestamp.",
      error: timestampError,
    };
  }

  console.log(`[Process Flow - ${input.senderId}] Received message: "${input.messageText}" at ${format(messageReceivedDate, 'yyyy-MM-dd HH:mm:ssXXX')}. Input:`, JSON.stringify(input));

  let responseText = "I'm sorry, I'm not sure how to help with that. Please try rephrasing or ask about appointments.";
  let recognizedIntentData: RecognizeIntentOutput | undefined = undefined;
  let finalResponseSent = false;
  let processingErrorDetail: string | undefined = undefined;

  try {
    // Refined sender type logic: Only doctor if senderId matches DOCTOR_WHATSAPP_NUMBER
    const isActualDoctor = process.env.DOCTOR_WHATSAPP_NUMBER && input.senderId === process.env.DOCTOR_WHATSAPP_NUMBER;
    const senderType = isActualDoctor ? 'doctor' : 'patient';
    console.log(`[Process Flow - ${input.senderId}] Sender type determined as: ${senderType} (Actual Doctor: ${isActualDoctor})`);

    recognizedIntentData = await recognizeIntent({
      message: input.messageText,
      senderType: senderType, // Pass the correct sender type to intent recognition
    });
    console.log(`[Process Flow - ${input.senderId}] Intent Recognition Result: Intent: ${recognizedIntentData.intent}, Entities: ${JSON.stringify(recognizedIntentData.entities)}, Original Message: "${recognizedIntentData.originalMessage}"`);

    const {intent, entities, originalMessage} = recognizedIntentData;

    const isHinglish = isHinglishMessage(input.messageText);
    console.log(`[Process Flow - ${input.senderId}] Detected language: ${isHinglish ? 'Hinglish' : 'English'}`);

    switch (intent) {
      case 'book_appointment': {
        const dateFromEntities = entities?.date as string;
        const timeFromEntities = entities?.time as string;
        const reasonFromEntities = entities?.reason as string;
        const patientName = entities?.patient_name as string;

        // Handle "today" or no date specified
        let bookingDate = dateFromEntities;
        if (!bookingDate || bookingDate.toLowerCase() === 'today') {
          bookingDate = format(new Date(), 'yyyy-MM-dd');
        }

        if (!timeFromEntities) {
          const parsedDate = parseISO(bookingDate);
          if (isValid(parsedDate)) {
            const dayOfWeek = getDay(parsedDate);
            if (dayOfWeek === 0 || dayOfWeek === 6) {
              responseText = `Sorry, the clinic is closed on weekends (${format(parsedDate, 'EEEE')}). Please choose a weekday (Monday to Friday) for your appointment.`;
              break;
            }
            
            // Get available slots once and cache them
            const { availableSlots, hasConflict, conflictDetails } = await checkAvailabilityAndConflicts(parsedDate);
            if (availableSlots.length === 0) {
              responseText = `I'm sorry, there are no available appointments for ${format(parsedDate, 'MMMM do, yyyy')}. Would you like to try another date?`;
              break;
            }
            
            responseText = `For ${format(parsedDate, 'MMMM do, yyyy')}, we have the following available time slots:\n${availableSlots.join(', ')}\n\nWhich time would you prefer?`;
            break;
          }
        }

        if (!patientName) {
          responseText = `Great! Could you please provide your name for the appointment?`;
          break;
        }

        if (!reasonFromEntities) {
          responseText = `Thank you ${patientName}. What is the reason for your visit?`;
          break;
        }

        const appointmentDateTime = parseDateTime(bookingDate, timeFromEntities);

        if (!appointmentDateTime) {
          responseText = `I couldn't quite understand the date or time ("${bookingDate}", "${timeFromEntities}"). Could you please provide them again clearly, like "next Monday at 2pm" or "July 25th at 10:00"?`;
          console.warn(`[Process Flow - ${input.senderId}] Booking failed: Unclear date/time after specific checks. Date entity: "${bookingDate}", Time entity: "${timeFromEntities}"`);
          break;
        }

        if (!isFuture(appointmentDateTime)) {
          responseText = `The appointment time ${formatDateTime(appointmentDateTime)} is in the past. Please choose a future time.`;
          break;
        }

        const dayOfWeek = getDay(appointmentDateTime);
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          responseText = `Sorry, the clinic is closed on weekends (${format(appointmentDateTime, 'EEEE')}). Please choose a weekday (Monday to Friday) for your appointment.`;
          console.warn(`[Process Flow - ${input.senderId}] Booking failed: Requested day ${format(appointmentDateTime, 'EEEE')} is a weekend.`);
          break;
        }

        const requestedHour = getHours(appointmentDateTime);
        if (requestedHour < DOCTOR_WORK_START_HOUR || requestedHour >= DOCTOR_WORK_END_HOUR) {
          responseText = `Sorry, the requested time ${format(appointmentDateTime, 'h a')} is outside our clinic hours (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR - 1), 'h a')}). Please choose a time within these hours.`;
          console.warn(`[Process Flow - ${input.senderId}] Booking failed: Requested time ${format(appointmentDateTime, 'HH:mm')} is outside working hours ${DOCTOR_WORK_START_HOUR}-${DOCTOR_WORK_END_HOUR}.`);
          break;
        }

        // Check if the requested time slot is available
        const requestedTimeStr = format(appointmentDateTime, 'h a');
        
        const { availableSlots, hasConflict, conflictDetails } = await checkAvailabilityAndConflicts(appointmentDateTime, timeFromEntities);
        if (!availableSlots.includes(requestedTimeStr)) {
          responseText = `I'm sorry, the time slot ${requestedTimeStr} is not available. Here are the available slots for ${format(appointmentDateTime, 'MMMM do, yyyy')}:\n${availableSlots.join(', ')}\n\nWould you like to book one of these slots instead?`;
          console.warn(`[Process Flow - ${input.senderId}] Booking failed: Requested time ${requestedTimeStr} is not available.`);
          break;
        }

        if (hasConflict) {
          responseText = getBilingualResponse('time_conflict', appointmentDateTime, undefined, isHinglish);
          break;
        }

        const finalReason = reasonFromEntities;
        console.log(`[Process Flow - ${input.senderId}] Booking: All details present. Date: ${bookingDate}, Time: ${timeFromEntities}, Reason: ${finalReason}. Parsed DateTime: ${appointmentDateTime}`);

        console.log(`[Process Flow - ${input.senderId}] Checking for conflicts for ${format(appointmentDateTime, 'yyyy-MM-dd HH:mm')}`);
        const existingAppointments = await getAppointmentsFromSheet({
          date: format(appointmentDateTime, 'yyyy-MM-dd'),
          status: ['booked', 'pending_confirmation', 'rescheduled']
        });
        const conflict = existingAppointments.find(app => {
          const appDateTime = parseDateTime(app.appointmentDate, app.appointmentTime);
          return appDateTime && appDateTime.getTime() === appointmentDateTime.getTime();
        });

        if (conflict) {
          responseText = `Sorry, the time slot ${format(appointmentDateTime, 'h a')} on ${format(appointmentDateTime, 'MMMM d')} is already booked. Would you like to try another time on this day, or perhaps a different day?`;
          console.warn(`[Process Flow - ${input.senderId}] Booking failed: Conflict found for ${format(appointmentDateTime, 'yyyy-MM-dd HH:mm')}. Conflict: ${JSON.stringify(conflict)}`);
          break;
        }
        console.log(`[Process Flow - ${input.senderId}] No conflicts found. Proceeding with booking.`);

        const appointmentStart = appointmentDateTime;
        const appointmentEnd = addMinutes(appointmentStart, APPOINTMENT_DURATION_MINUTES); 

        const newAppointmentId = input.messageId;

        const calendarEventData: CalendarEventArgs = {
          summary: `Appt: ${finalReason} - ${input.senderName || input.senderId}`,
          description: `Patient: ${input.senderName || 'Unknown'} (${input.senderId})\nReason: ${finalReason}\nDuration: ${APPOINTMENT_DURATION_MINUTES} minutes\nBooked via WhatsApp. WA Msg ID: ${newAppointmentId}`,
          startTime: appointmentStart.toISOString(),
          endTime: appointmentEnd.toISOString(),
        };
        console.log(`[Process Flow - ${input.senderId}] Creating calendar event:`, calendarEventData);
        const [calendarEvent, sheetResult] = await Promise.all([
          retryOperation(() => createCalendarEvent(calendarEventData)),
          retryOperation(() => addAppointmentToSheet({
            id: input.messageId,
            patientName: input.senderName || 'Patient',
            phoneNumber: input.senderId,
            appointmentDate: format(appointmentStart, 'yyyy-MM-dd'),
            appointmentTime: format(appointmentStart, 'HH:mm'),
            reason: finalReason,
            status: 'booked',
            notes: `Booked via WhatsApp. Original message: "${originalMessage}"`,
          }))
        ]);

        if (!isValidCalendarId(calendarEvent?.id) || !isValidRowIndex(sheetResult?.rowIndex)) {
          // If either operation failed, clean up
          if (isValidCalendarId(calendarEvent?.id)) {
            console.log(`[Process Flow - ${input.senderId}] Attempting to clean up created calendar event: ${calendarEvent.id}`);
            await retryOperation(() => {
              if (!calendarEvent.id) throw new Error('Invalid calendar event ID');
              return deleteCalendarEvent(calendarEvent.id);
            }).catch(e => console.error(`[Process Flow - ${input.senderId}] Failed to cleanup calendar event ${calendarEvent.id}:`, e));
          }
          if (isValidRowIndex(sheetResult?.rowIndex)) {
            console.log(`[Process Flow - ${input.senderId}] Attempting to mark sheet row ${sheetResult.rowIndex} as cancelled.`);
            await retryOperation(() => {
              if (!sheetResult.rowIndex) throw new Error('Invalid row index');
              return updateAppointmentInSheet(sheetResult.rowIndex, {
                status: 'cancelled',
                notes: 'Booking failed: Calendar event creation or sheet add failed.'
              });
            }).catch(e => console.error(`[Process Flow - ${input.senderId}] Failed to update sheet row ${sheetResult.rowIndex} to cancelled:`, e));
          }
          responseText = getBilingualResponse('booking_failed', undefined, undefined, isHinglish);
          break;
        }

        // Update sheet with calendar event ID
        await retryOperation(() => {
          if (!sheetResult.rowIndex) throw new Error('Invalid row index');
          const calendarEventId = calendarEvent.id;
          if (!calendarEventId) throw new Error('Invalid calendar event ID');
          return updateAppointmentInSheet(sheetResult.rowIndex, { 
            calendarEventId
          });
        });
        responseText = getBilingualResponse('booking_confirmed', finalReason, appointmentStart, isHinglish);
        break;
      }

      case 'reschedule_appointment': {
        let newDateEntity = entities?.date as string;
        let newTimeEntity = entities?.time as string;
        // If only time is provided, we'll ask for the date
        if (newTimeEntity && !newDateEntity) {
          responseText = "I need to know which date you'd like to reschedule to. Please provide the date.";
          console.log(`[Process Flow - ${input.senderId}] Reschedule: Time provided but date missing. Asking for date.`);
          break;
        }

        const newDateTime = parseDateTime(newDateEntity, newTimeEntity);
        if (!newDateTime) {
          responseText = `I couldn't understand the new date or time for rescheduling (date: "${newDateEntity}", time: "${newTimeEntity}"). Please provide it clearly. If you meant to reschedule for the same day, please specify 'same day' or the date again with the new time.`;
          console.warn(`[Process Flow - ${input.senderId}] Reschedule failed: Unclear new date/time. Date entity: "${newDateEntity}", Time entity: "${newTimeEntity}"`);
          break;
        }
        if (!isFuture(newDateTime)) {
            responseText = `The new appointment time ${formatDateTime(newDateTime)} is in the past. Please choose a future time.`;
            console.warn(`[Process Flow - ${input.senderId}] Reschedule failed: Past new date/time. Parsed: ${newDateTime}`);
            break;
        }

        const dayOfWeek = getDay(newDateTime);
        const requestedHour = getHours(newDateTime);
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          responseText = `Sorry, the clinic is closed on weekends (${format(newDateTime, 'EEEE')}). Please choose a weekday (Monday to Friday) for your rescheduled appointment.`;
          break;
        }
        if (requestedHour < DOCTOR_WORK_START_HOUR || requestedHour >= DOCTOR_WORK_END_HOUR) {
          responseText = `Sorry, the new time ${format(newDateTime, 'h a')} is outside clinic hours (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR -1), 'h a')}). Please choose another time.`;
          break;
        }

        if (isBookingPaused) {
          try {
            const requestedDateObj = newDateTime;
            const isPausedForRequestedDate = 
              (pauseStartDate && pauseEndDate && isWithinInterval(requestedDateObj, { start: startOfDay(pauseStartDate), end: endOfDay(pauseEndDate) })) ||
              (pauseStartDate && !pauseEndDate && isSameDay(requestedDateObj, pauseStartDate));
            
            if (isPausedForRequestedDate) {
              responseText = getBilingualResponse('pause_booking', pauseStartDate!, pauseEndDate!, isHinglish);
              break;
            }
          } catch(e) {
            console.warn(`[Process Flow - ${input.senderId}] Error checking pause status during reschedule:`, e);
          }
        }

        if (senderType === 'patient') {
          console.log(`[Process Flow - ${input.senderId}] Patient rescheduling: Finding existing appointment.`);
          const existingAppointment = await findAppointment({ phoneNumber: input.senderId, status: ['booked', 'pending_confirmation', 'rescheduled'] });
          if (!existingAppointment) {
            responseText = "I couldn't find an existing appointment for you to reschedule. Would you like to book a new one?";
            console.warn(`[Process Flow - ${input.senderId}] Reschedule failed: No existing appointment found for patient.`);
            break;
          }
          if (!isValidRowIndex(existingAppointment.rowIndex) || !isValidCalendarId(existingAppointment.calendarEventId)) {
             responseText = "I found your appointment, but there's an issue with its record needed for rescheduling. Please contact the clinic directly.";
             console.error(`[Process Flow - ${input.senderId}] Patient reschedule error: Missing rowIndex (${existingAppointment.rowIndex}) or calendarEventId (${existingAppointment.calendarEventId}) for appointment ID ${existingAppointment.id}`);
             processingErrorDetail = "Patient appointment record incomplete for rescheduling.";
             break;
          }
          console.log(`[Process Flow - ${input.senderId}] Found appointment to reschedule: ID ${existingAppointment.id}, Row ${existingAppointment.rowIndex}, CalendarEventID ${existingAppointment.calendarEventId}`);

          const newStartTime = newDateTime;
          const newEndTime = addMinutes(newStartTime, 60);

          console.log(`[Process Flow - ${input.senderId}] Updating appointment in sheet (row ${existingAppointment.rowIndex}) and calendar (${existingAppointment.calendarEventId}).`);
          await Promise.all([
            retryOperation(() => {
              if (!existingAppointment.rowIndex) throw new Error('Invalid row index');
              return updateAppointmentInSheet(existingAppointment.rowIndex, {
                appointmentDate: format(newStartTime, 'yyyy-MM-dd'),
                appointmentTime: format(newStartTime, 'HH:mm'),
                status: 'rescheduled',
                notes: `${existingAppointment.notes || ''}\nRescheduled by patient on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. Original: ${existingAppointment.appointmentDate} ${existingAppointment.appointmentTime}. WA Msg ID: ${input.messageId}`,
              });
            }),
            isValidCalendarId(existingAppointment.calendarEventId) ? retryOperation(() => {
              if (!existingAppointment.calendarEventId) throw new Error('Invalid calendar event ID');
              return updateCalendarEvent(existingAppointment.calendarEventId, {
                startTime: newStartTime.toISOString(),
                endTime: newEndTime.toISOString(),
                summary: `(RESCHEDULED) Appt: ${existingAppointment.reason} - ${existingAppointment.patientName}`,
              });
            }) : Promise.resolve()
          ]);
          responseText = getBilingualResponse('reschedule_confirmed', newStartTime, newEndTime, isHinglish);
        } else { 
          const patientNameToReschedule = entities?.patient_name as string;
          if (!patientNameToReschedule) {
              responseText = "Doctor, please provide the patient name to reschedule. Format: /reschedule [Patient Name] to [YYYY-MM-DD] at [HH:MM]";
              console.warn(`[Process Flow - ${input.senderId}] Doctor reschedule failed: Missing patient name.`);
              break;
          }
          console.log(`[Process Flow - ${input.senderId}] Doctor rescheduling for patient: "${patientNameToReschedule}"`);

          const appointmentToReschedule = await findAppointment({ patientName: patientNameToReschedule, status: ['booked', 'pending_confirmation', 'rescheduled']});
          if (!appointmentToReschedule || !isValidRowIndex(appointmentToReschedule.rowIndex) || !isValidCalendarId(appointmentToReschedule.calendarEventId)) {
              responseText = `Could not find an active appointment for "${patientNameToReschedule}" to reschedule.`;
              console.warn(`[Process Flow - ${input.senderId}] Doctor reschedule failed: No appointment found for "${patientNameToReschedule}". Result: ${JSON.stringify(appointmentToReschedule)}`);
              break;
          }
          console.log(`[Process Flow - ${input.senderId}] Found appointment for "${patientNameToReschedule}" to reschedule: ID ${appointmentToReschedule.id}, Row ${appointmentToReschedule.rowIndex}, CalendarEventID ${appointmentToReschedule.calendarEventId}`);

          const newStartTime = newDateTime;
          const newEndTime = addMinutes(newStartTime, 60);

          console.log(`[Process Flow - ${input.senderId}] Updating appointment in sheet (row ${appointmentToReschedule.rowIndex}) and calendar (${appointmentToReschedule.calendarEventId}) for doctor's request.`);
          await Promise.all([
            retryOperation(() => {
              if (!appointmentToReschedule.rowIndex) throw new Error('Invalid row index');
              return updateAppointmentInSheet(appointmentToReschedule.rowIndex, {
                appointmentDate: format(newStartTime, 'yyyy-MM-dd'),
                appointmentTime: format(newStartTime, 'HH:mm'),
                status: 'rescheduled',
                notes: `${appointmentToReschedule.notes || ''}\nRescheduled by doctor on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}`,
              });
            }),
            isValidCalendarId(appointmentToReschedule.calendarEventId) ? retryOperation(() => {
              if (!appointmentToReschedule.calendarEventId) throw new Error('Invalid calendar event ID');
              return updateCalendarEvent(appointmentToReschedule.calendarEventId, {
                startTime: newStartTime.toISOString(),
                endTime: newEndTime.toISOString(),
                summary: `(RESCHEDULED by Dr.) Appt: ${appointmentToReschedule.reason} - ${appointmentToReschedule.patientName}`,
              });
            }) : Promise.resolve()
          ]);  
          responseText = getBilingualResponse('reschedule_confirmed', newStartTime, newEndTime, isHinglish);
        }
        break;
      }

      case 'cancel_appointment': {
         if (senderType === 'patient') {
          console.log(`[Process Flow - ${input.senderId}] Patient cancelling appointment: Finding existing appointment.`);
          const appointmentToCancel = await findAppointment({ phoneNumber: input.senderId, status: ['booked', 'pending_confirmation', 'rescheduled'] });
          if (!appointmentToCancel) {
            responseText = "I couldn't find an active appointment for you to cancel.";
            console.warn(`[Process Flow - ${input.senderId}] Patient cancel failed: No existing appointment found.`);
            break;
          }
           if (!isValidRowIndex(appointmentToCancel.rowIndex) || !isValidCalendarId(appointmentToCancel.calendarEventId)) {
             responseText = "I found your appointment, but there's an issue with its record needed for cancellation. Please contact the clinic directly.";
             console.error(`[Process Flow - ${input.senderId}] Patient cancel error: Missing rowIndex (${appointmentToCancel.rowIndex}) or calendarEventId (${appointmentToCancel.calendarEventId}) for appointment ID ${appointmentToCancel.id}`);
             processingErrorDetail = "Patient appointment record incomplete for cancellation.";
             break;
          }
          console.log(`[Process Flow - ${input.senderId}] Found appointment to cancel: ID ${appointmentToCancel.id}, Row ${appointmentToCancel.rowIndex}, CalendarEventID ${appointmentToCancel.calendarEventId}`);
      await Promise.all([
         isValidCalendarId(appointmentToCancel.calendarEventId) ? retryOperation(() => {
           if (!appointmentToCancel.calendarEventId) throw new Error('Invalid calendar event ID');
           return deleteCalendarEvent(appointmentToCancel.calendarEventId);
         }) : Promise.resolve(),
         retryOperation(() => {
           if (!appointmentToCancel.rowIndex) throw new Error('Invalid row index');
           return updateAppointmentInSheet(appointmentToCancel.rowIndex, { 
             status: 'cancelled', 
             notes: `${appointmentToCancel.notes || ''}\nCancelled on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}` 
            });
           })
          ]);
          responseText = getBilingualResponse('cancellation_confirmed', undefined, undefined, isHinglish);
        } else { 
          const patientNameToCancel = entities?.patient_name as string;
          const dateToCancel = entities?.date as string;

          if (!patientNameToCancel) {
              responseText = "Doctor, please provide the patient name to cancel. Format: /cancel [Patient Name] appointment (optionally add 'for YYYY-MM-DD' or 'for today')";
              console.warn(`[Process Flow - ${input.senderId}] Doctor cancel failed: Missing patient name.`);
              break;
          }
          console.log(`[Process Flow - ${input.senderId}] Doctor cancelling for patient: "${patientNameToCancel}"${dateToCancel ? ` on ${dateToCancel}` : ''}.`);
          const specificDateToQuery = (dateToCancel === format(new Date(), 'yyyy-MM-dd') || dateToCancel?.toLowerCase() === 'today')
                                       ? format(new Date(), 'yyyy-MM-dd')
                                       : dateToCancel;

          const appointmentToCancel = await findAppointment({
              patientName: patientNameToCancel,
              date: specificDateToQuery,
              status: ['booked', 'pending_confirmation', 'rescheduled']
          });

           if (!appointmentToCancel || !isValidRowIndex(appointmentToCancel.rowIndex) || !isValidCalendarId(appointmentToCancel.calendarEventId)) {
              responseText = `Could not find an active appointment for "${patientNameToCancel}" ${specificDateToQuery ? `on ${specificDateToQuery}` : ''} to cancel.`;
              console.warn(`[Process Flow - ${input.senderId}] Doctor cancel failed: No appointment found for "${patientNameToCancel}" ${specificDateToQuery ? `on ${specificDateToQuery}` : ''}. Result: ${JSON.stringify(appointmentToCancel)}`);
              break;
          }
          console.log(`[Process Flow - ${input.senderId}] Found appointment for "${patientNameToCancel}" to cancel: ID ${appointmentToCancel.id}, Row ${appointmentToCancel.rowIndex}, CalendarEventID ${appointmentToCancel.calendarEventId}`);
          await Promise.all([
            isValidCalendarId(appointmentToCancel.calendarEventId) ? retryOperation(() => {
              if (!appointmentToCancel.calendarEventId) throw new Error('Invalid calendar event ID');
              return deleteCalendarEvent(appointmentToCancel.calendarEventId);
            }) : Promise.resolve(),
            retryOperation(() => {
              if (!appointmentToCancel.rowIndex) throw new Error('Invalid row index');
              return updateAppointmentInSheet(appointmentToCancel.rowIndex, { 
                status: 'cancelled', 
                notes: `${appointmentToCancel.notes || ''}\nCancelled on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}` 
              });
            })
          ]);    
          responseText = getBilingualResponse('cancellation_confirmed', undefined, undefined, isHinglish);
        }
        break;
      }
      
      case 'query_availability': {
        const dateFromEntities = entities?.date as string;
        let queryDate: Date;
        
        // Handle relative dates (today, tomorrow, yesterday) or specific date
        if (dateFromEntities) {
          const relativeDate = parseRelativeDate(dateFromEntities);
          if (relativeDate) {
            queryDate = relativeDate;
          } else {
            const parsedQueryDate = parseISO(dateFromEntities);
            if (!isValid(parsedQueryDate)) {
              responseText = "I couldn't understand that date. Please provide a valid date or ask about today's/tomorrow's availability.";
              break;
            }
            queryDate = parsedQueryDate;
          }
        } else {
          queryDate = new Date(); // Default to today if no date specified
        }

        if (!isFuture(queryDate) && !isSameDay(queryDate, new Date())) {
          responseText = "Please provide a future date to check availability.";
          break;
        }

        const dayOfWeek = getDay(queryDate);
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          responseText = `Sorry, the clinic is closed on weekends (${format(queryDate, 'EEEE')}). Please choose a weekday (Monday to Friday) for your appointment.`;
          break;
        }

        // Get available slots
        const { availableSlots, hasConflict, conflictDetails } = await checkAvailabilityAndConflicts(queryDate);
        
        if (availableSlots.length === 0) {
          responseText = getBilingualResponse('no_slots', queryDate, undefined, isHinglish);
        } else {
          responseText = `${formatDateTime(queryDate, false)} ke liye ye slots available hain:\n${availableSlots.join(', ')}\n\nHar appointment 45 minutes ki hoti hai, uske baad 15 minutes ka break hota hai. Kya aap inme se koi slot book karna chahenge?`;
        }

        if (isBookingPaused) {
          try {
            const isPausedForQueryDate = 
              (pauseStartDate && pauseEndDate && isWithinInterval(queryDate, { start: startOfDay(pauseStartDate), end: endOfDay(pauseEndDate) })) ||
              (pauseStartDate && !pauseEndDate && isSameDay(queryDate, pauseStartDate));
            
            if (isPausedForQueryDate) {
              if (pauseStartDate && pauseEndDate && !isSameDay(pauseStartDate, pauseEndDate)) {
                responseText = `I'm sorry, we are not accepting new bookings from ${formatDateTime(pauseStartDate, false)} to ${formatDateTime(pauseEndDate, false)}. Please try checking availability for a different date.`;
              } else {
                responseText = `I'm sorry, we are not accepting new bookings for ${formatDateTime(pauseStartDate!, false)}. Please try checking availability for a different date.`;
              }
              break;
            }
          } catch(e) {
            console.warn(`[Process Flow - ${input.senderId}] Error checking pause status during availability check:`, e);
          }
        }
        break;
      }

      case 'pause_bookings': {
          if (senderType !== 'doctor') {
              responseText = "Sorry, only doctors can pause bookings.";
              console.warn(`[Process Flow - ${input.senderId}] Unauthorized attempt to pause bookings by non-doctor.`);
              break;
          }
          const startDateStr = entities?.start_date as string; 
          const endDateStr = entities?.end_date as string;   

          let conflictsMessage = "";
          let parsedPauseStart: Date | null = null;
          let parsedPauseEnd: Date | null = null;

          if (startDateStr) {
              try {
                  parsedPauseStart = parseISO(startDateStr);
                  if (!isValid(parsedPauseStart)) parsedPauseStart = null;
              } catch { parsedPauseStart = null; }
          }
          if (endDateStr) {
              try {
                  parsedPauseEnd = parseISO(endDateStr);
                  if (!isValid(parsedPauseEnd)) parsedPauseEnd = null;
              } catch { parsedPauseEnd = null; }
          }
          
          if (parsedPauseStart && !parsedPauseEnd) {
              parsedPauseEnd = parsedPauseStart;
          }

          if (parsedPauseStart && parsedPauseEnd) {
              if (parsedPauseStart > parsedPauseEnd) {
                  responseText = "Doctor, the start date for pausing bookings cannot be after the end date. Please try again.";
                  console.warn(`[Process Flow - ${input.senderId}] Pause bookings failed: Start date after end date. Start: ${startDateStr}, End: ${endDateStr}`);
                  break;
              }
              
              console.log(`[Process Flow - ${input.senderId}] Checking for existing appointments between ${format(parsedPauseStart, 'yyyy-MM-dd')} and ${format(parsedPauseEnd, 'yyyy-MM-dd')} before pausing.`);
              const existingEvents = await getCalendarEventsForDateRange(format(parsedPauseStart, 'yyyy-MM-dd'), format(parsedPauseEnd, 'yyyy-MM-dd'));
              
              if (existingEvents.length > 0) {
                  const eventTimes = existingEvents.map(event => 
                      `${event.summary} on ${event.start?.dateTime ? format(parseISO(event.start.dateTime), 'MMMM d, yyyy at h a') : 'N/A'}`
                  ).join('\n- ');
                  conflictsMessage = `\n\nIMPORTANT: You have ${existingEvents.length} existing appointment(s) during this period:\n- ${eventTimes}\n\nThese appointments will NOT be automatically cancelled. Patients will still be able to reschedule their existing appointments.`;
              }

              isBookingPaused = true;
              pauseStartDate = parsedPauseStart;
              pauseEndDate = parsedPauseEnd;
              responseText = `Okay, doctor. New bookings are now paused from ${formatDateTime(parsedPauseStart, false)} to ${formatDateTime(parsedPauseEnd, false)}.${conflictsMessage}\n\nTo resume bookings before ${formatDateTime(parsedPauseEnd, false)}, use the command: /resume bookings`;
              console.log(`[Process Flow - ${input.senderId}] Bookings paused from ${format(parsedPauseStart, 'yyyy-MM-dd')} to ${format(parsedPauseEnd, 'yyyy-MM-dd')}.${conflictsMessage ? ' Conflicts noted.' : ''}`);
          } else if (parsedPauseStart) { 
              isBookingPaused = true;
              pauseStartDate = parsedPauseStart;
              pauseEndDate = parsedPauseStart; 
              responseText = `Okay, doctor. New bookings are now paused for ${formatDateTime(parsedPauseStart, false)}.\n\nTo resume bookings before this date, use the command: /resume bookings`;
              console.log(`[Process Flow - ${input.senderId}] Bookings paused for single day: ${format(parsedPauseStart, 'yyyy-MM-dd')}`);
          } else { 
              isBookingPaused = true; 
              pauseStartDate = null;  
              pauseEndDate = null;
              responseText = "Okay, doctor. New bookings are now paused indefinitely until you resume them.\n\nTo resume bookings, use the command: /resume bookings\n\nIf you meant to pause for specific dates, please try again with the dates (e.g., '/pause bookings from YYYY-MM-DD to YYYY-MM-DD').";
              console.log(`[Process Flow - ${input.senderId}] Bookings paused indefinitely (no dates specified).`);
          }
          break;
      }
      case 'resume_bookings': {
          if (senderType !== 'doctor') {
              responseText = "Sorry, only doctors can resume bookings.";
              console.warn(`[Process Flow - ${input.senderId}] Unauthorized attempt to resume bookings by non-doctor.`);
              break;
          }
          isBookingPaused = false;
          pauseStartDate = null;
          pauseEndDate = null;
          responseText = "Okay, doctor. Bookings are now resumed.";
          console.log(`[Process Flow - ${input.senderId}] Doctor command: Resume bookings.`);
          break;
      }
      case 'cancel_all_meetings_today': {
          if (senderType !== 'doctor') {
              responseText = "Sorry, only doctors can cancel all meetings.";
              console.warn(`[Process Flow - ${input.senderId}] Unauthorized attempt to cancel all meetings by non-doctor.`);
              break;
          }
          const todayStr = format(new Date(), 'yyyy-MM-dd');
          console.log(`[Process Flow - ${input.senderId}] Doctor command: Cancel all meetings for today (${todayStr}).`);
          const todaysAppointments = await getAppointmentsFromSheet({ date: todayStr, status: ['booked', 'rescheduled', 'pending_confirmation'] });
          if (todaysAppointments.length === 0) {
              responseText = "Doctor, there are no booked or rescheduled appointments for today to cancel.";
              console.log(`[Process Flow - ${input.senderId}] No appointments to cancel for today.`);
              break;
          }
          let cancelledCount = 0;
          let patientNotifications: string[] = [];
          console.log(`[Process Flow - ${input.senderId}] Found ${todaysAppointments.length} appointments to cancel for today.`);
          for (const app of todaysAppointments) {
              if (isValidRowIndex(app.rowIndex) && isValidCalendarId(app.calendarEventId)) {
                  try {
                      console.log(`[Process Flow - ${input.senderId}] Cancelling appointment ID ${app.id} (Row: ${app.rowIndex}, Calendar: ${app.calendarEventId}) for 'cancel all today'.`);
                      await Promise.all([
                        retryOperation(() => {
                          if (!app.rowIndex) throw new Error('Invalid row index');
                          return updateAppointmentInSheet(app.rowIndex, { 
                            status: 'cancelled', 
                            notes: `${app.notes || ''}\nCancelled by doctor (all today) on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}`
                          });
                        }),
                        isValidCalendarId(app.calendarEventId) ? retryOperation(() => {
                          if (!app.calendarEventId) throw new Error('Invalid calendar event ID');
                          return deleteCalendarEvent(app.calendarEventId);
                        }) : Promise.resolve()
                      ]); 
                      cancelledCount++;
                      patientNotifications.push(`${app.patientName} (${app.appointmentTime})`);
                  } catch (e: any) {
                      console.error(`[Process Flow - ${input.senderId}] Error cancelling appointment ID ${app.id} for 'cancel all today':`, e);
                  }
              } else {
                   console.warn(`[Process Flow - ${input.senderId}] Skipping appointment ID ${app.id} for 'cancel all today' due to invalid rowIndex or calendarEventId. Details: ${JSON.stringify(app)}`);
              }
          }
          if (cancelledCount > 0) {
              responseText = `Okay, doctor. Cancelled ${cancelledCount} appointment(s) for today: ${patientNotifications.join(', ')}. You may want to notify them individually.`;
          } else {
              responseText = "Doctor, I found appointments for today but encountered issues cancelling them or no valid appointments to cancel. Please check the logs or Google Sheet/Calendar.";
          }
          break;
      }

      case 'greeting':
        responseText = "Hello! I'm MediMate AI, your WhatsApp assistant for Dr. [Doctor's Name]'s clinic. How can I help you with your appointments today?";
        break;
      case 'thank_you':
        responseText = "You're very welcome! Is there anything else I can assist you with?";
        break;
      case 'faq_opening_hours':
        responseText = `The clinic is open from ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR),'h a')} to ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR -1 ),'h:mm a')}, Monday to Friday. We are closed on weekends and public holidays.`;
        break;
      case 'other':
      default: {
        const conversationalPrompt = `You are MediMate AI, a friendly and helpful WhatsApp assistant for Dr. [Doctor's Name]'s clinic.
The user (a ${senderType}) sent: "${input.messageText}".
Your primary functions are to help with booking, rescheduling, or cancelling appointments. You can also answer simple questions about the clinic like opening hours (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR -1 ), 'h:mm a')}).
If the user's message seems related to these functions, guide them or ask for clarification.
If the message is a general health query, provide a very brief, general, non-diagnostic piece of advice and strongly recommend booking an appointment for any medical concerns. Do NOT attempt to diagnose or give specific medical advice.
If the message is a simple greeting or social interaction, respond politely and conversationally.
If the message is completely unrelated or very unclear, politely state that you can primarily assist with appointments and clinic information.
Keep your responses concise and helpful for WhatsApp. Be friendly and empathetic. If you don't understand, ask for clarification rather than giving a generic 'I don't understand'. Try to infer context if a user replies to your direct question.`;

        try {
          console.log(`[Process Flow - ${input.senderId}] Fallback to conversational AI prompt for message: "${input.messageText}" (Intent: ${intent}, Entities: ${JSON.stringify(entities)})`);
          // For now, use a simple response since we don't have AI generation set up
          responseText = "I'm sorry, I didn't quite understand that. I can help with booking, rescheduling, or cancelling appointments, or provide information about the clinic. How can I assist you?";
        } catch (genError: any) {
          console.error(`[Process Flow - ${input.senderId}] Error generating conversational AI response:`, genError.message || String(genError), genError.stack);
          responseText = "I'm sorry, I'm having a little trouble understanding. Could you please rephrase? You can ask me to book, reschedule, or cancel an appointment.";
          processingErrorDetail = `Conversational AI generation failed: ${genError.message || String(genError)}`;
        }
      }
    }
  } catch (flowError: any) {
    console.error(`[Process Flow - ${input.senderId}] CRITICAL ERROR in processWhatsAppMessage's main try block:`, flowError.message || String(flowError), flowError.stack);
    responseText = "I'm sorry, an internal error occurred while processing your request. Please try again in a few moments. If the problem persists, please contact the clinic directly.";
    processingErrorDetail = `Flow error: ${flowError.message || String(flowError)}. Stack: ${flowError.stack}`;
  } finally {
    console.log(`[Process Flow - ${input.senderId}] Attempting to send final response: "${responseText}"`);
    try {
      const sendResult = await sendWhatsAppMessage(input.senderId, responseText);
      finalResponseSent = sendResult.success;
      if (!sendResult.success) {
        const sendErrorMessage = `Failed to send WhatsApp response: ${sendResult.error}`;
        console.error(`[Process Flow - ${input.senderId}] ${sendErrorMessage}`);
        if (!processingErrorDetail) {
          processingErrorDetail = sendErrorMessage;
        }
      } else {
        console.log(`[Process Flow - ${input.senderId}] WhatsApp response sent successfully. Message ID: ${sendResult.messageId}`);
      }
    } catch (sendException: any) {
      const sendExceptionMessage = `Exception during sendWhatsAppMessage: ${sendException.message || String(sendException)}`;
      console.error(`[Process Flow - ${input.senderId}] ${sendExceptionMessage}`, sendException.stack);
      finalResponseSent = false;
      if (!processingErrorDetail) {
        processingErrorDetail = sendExceptionMessage;
      }
    }
  }

  console.log(`[Process Flow - ${input.senderId}] Flow complete. Response Sent: ${finalResponseSent}, Error: ${processingErrorDetail || 'None'}`);
  return {
    responseSent: finalResponseSent,
    responseText: responseText,
    intentData: recognizedIntentData, 
    error: processingErrorDetail,
  };
}

// Add this function at the end of the file
export async function sendDailyAppointmentSummary(): Promise<void> {
  try {
    const today = new Date();
    const appointments = await getAppointmentsFromSheet({
      date: format(today, 'yyyy-MM-dd'),
      status: ['booked', 'pending_confirmation']
    });

    if (appointments.length === 0) {
      console.log('[Daily Summary] No appointments found for today');
      return;
    }

    const summary = appointments.map(app => 
      `- ${app.patientName}: ${app.appointmentTime} (${app.reason})`
    ).join('\n');

    const message = `📅 Today's Appointments (${format(today, 'MMMM do, yyyy')}):\n\n${summary}`;
    
    // Send to doctor's WhatsApp
    // Note: You'll need to implement the actual sending mechanism
    console.log('[Daily Summary] Sending summary to doctor:', message);
  } catch (error) {
    console.error('[Daily Summary] Error sending daily summary:', error);
  }
}