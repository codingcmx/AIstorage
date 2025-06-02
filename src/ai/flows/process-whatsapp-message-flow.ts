
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

import {ai} from '@/ai/genkit';
import {z}from 'genkit';
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
  getDay, // Added for weekday check
} from 'date-fns';


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


export async function processWhatsAppMessage(
  input: ProcessWhatsAppMessageInput
): Promise<ProcessWhatsAppMessageOutput> {
  return processWhatsAppMessageFlow(input);
}

const processWhatsAppMessageFlow = ai.defineFlow(
  {
    name: 'processWhatsAppMessageFlow',
    inputSchema: ProcessWhatsAppMessageInputSchema,
    outputSchema: ProcessWhatsAppMessageOutputSchema,
  },
  async (input: ProcessWhatsAppMessageInput): Promise<ProcessWhatsAppMessageOutput> => {
    let messageReceivedDate: Date;
    try {
        messageReceivedDate = parseISO(input.timestamp); // input.timestamp is already an ISO string
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
      const isLikelyDoctor = input.messageText.startsWith('/') || (process.env.DOCTOR_WHATSAPP_NUMBER && input.senderId === process.env.DOCTOR_WHATSAPP_NUMBER);
      const senderType = isLikelyDoctor ? 'doctor' : 'patient';
      console.log(`[Process Flow - ${input.senderId}] Sender type determined as: ${senderType}`);

      recognizedIntentData = await recognizeIntent({
        message: input.messageText,
        senderType: senderType,
      });
      console.log(`[Process Flow - ${input.senderId}] Intent Recognition Result: Intent: ${recognizedIntentData.intent}, Entities: ${JSON.stringify(recognizedIntentData.entities)}, Original Message: "${recognizedIntentData.originalMessage}"`);

      const {intent, entities, originalMessage} = recognizedIntentData;


      switch (intent) {
        case 'book_appointment': {
          const reasonFromEntities = entities?.reason as string;
          let dateFromEntities = entities?.date as string; 
          let timeFromEntities = entities?.time as string; 

          console.log(`[Process Flow - ${input.senderId}] Booking: Initial entities - Date: ${dateFromEntities}, Time: ${timeFromEntities}, Reason: ${reasonFromEntities}`);

          if (isBookingPaused && dateFromEntities) {
            try {
                const requestedDateObj = parseISO(dateFromEntities);
                if (isValid(requestedDateObj)) {
                    const isPausedForRequestedDate = 
                        (pauseStartDate && pauseEndDate && isWithinInterval(requestedDateObj, { start: startOfDay(pauseStartDate), end: endOfDay(pauseEndDate) })) ||
                        (pauseStartDate && !pauseEndDate && isSameDay(requestedDateObj, pauseStartDate));
                    
                    if (isPausedForRequestedDate) {
                        responseText = `I'm sorry, we are not accepting new bookings for ${format(requestedDateObj, 'MMMM do')}${pauseEndDate && !isSameDay(pauseStartDate!, pauseEndDate) ? ` (paused until ${format(pauseEndDate, 'MMMM do')})` : ''}. Please try a different date or check back later.`;
                        console.log(`[Process Flow - ${input.senderId}] Booking attempt for ${dateFromEntities} during paused period. Pause: ${pauseStartDate ? format(pauseStartDate, 'yyyy-MM-dd') : 'N/A'} - ${pauseEndDate ? format(pauseEndDate, 'yyyy-MM-dd') : 'N/A'}`);
                        break; 
                    }
                }
            } catch(e) {
                console.warn(`[Process Flow - ${input.senderId}] Error parsing dateFromEntities '${dateFromEntities}' during pause check:`, e);
            }
          }

          if (!dateFromEntities) {
            responseText = "Sure, I can help you book an appointment! What day were you thinking of?";
            console.log(`[Process Flow - ${input.senderId}] Booking: Date missing. Asking for date.`);
            break;
          }

          if (!timeFromEntities) {
            responseText = `Okay, for ${dateFromEntities}. What time would you like to come in?`;
            console.log(`[Process Flow - ${input.senderId}] Booking: Time missing for date ${dateFromEntities}. Asking for time.`);
            break;
          }
          
          const appointmentDateTime = parseDateTime(dateFromEntities, timeFromEntities);

          if (!appointmentDateTime) {
            responseText = `I couldn't quite understand the date or time ("${dateFromEntities}", "${timeFromEntities}"). Could you please provide them again clearly, like "next Monday at 2pm" or "July 25th at 10:00"?`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Unclear date/time after specific checks. Date entity: "${dateFromEntities}", Time entity: "${timeFromEntities}"`);
            break;
          }

          if (!isFuture(appointmentDateTime)) {
            responseText = `The appointment time ${format(appointmentDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Past date/time. Parsed: ${appointmentDateTime}`);
            break;
          }

          const dayOfWeek = getDay(appointmentDateTime); // 0 (Sunday) to 6 (Saturday)
          const requestedHour = getHours(appointmentDateTime);

          if (dayOfWeek === 0 || dayOfWeek === 6) { // Sunday or Saturday
            responseText = `Sorry, the clinic is closed on weekends (${format(appointmentDateTime, 'EEEE')}). Please choose a weekday (Monday to Friday) for your appointment.`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Requested day ${format(appointmentDateTime, 'EEEE')} is a weekend.`);
            break;
          }
          if (requestedHour < DOCTOR_WORK_START_HOUR || requestedHour >= DOCTOR_WORK_END_HOUR) {
            responseText = `Sorry, the requested time ${format(appointmentDateTime, 'h:mm a')} is outside our clinic hours (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR -1 ), 'h:mm a')}). Please choose a time within these hours.`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Requested time ${format(appointmentDateTime, 'HH:mm')} is outside working hours ${DOCTOR_WORK_START_HOUR}-${DOCTOR_WORK_END_HOUR}.`);
            break;
          }

          if (!reasonFromEntities) {
            responseText = `Got it, ${format(appointmentDateTime, 'MMM d, yyyy')} at ${format(appointmentDateTime, 'h:mm a')}. And what is the reason for your visit?`;
            console.log(`[Process Flow - ${input.senderId}] Booking: Reason missing for ${format(appointmentDateTime, 'yyyy-MM-dd HH:mm')}. Asking for reason.`);
            break;
          }

          const finalReason = reasonFromEntities;
          console.log(`[Process Flow - ${input.senderId}] Booking: All details present. Date: ${dateFromEntities}, Time: ${timeFromEntities}, Reason: ${finalReason}. Parsed DateTime: ${appointmentDateTime}`);

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
            responseText = `Sorry, the time slot ${format(appointmentDateTime, 'h:mm a')} on ${format(appointmentDateTime, 'MMMM d')} is already booked. Would you like to try another time on this day, or perhaps a different day?`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Conflict found for ${format(appointmentDateTime, 'yyyy-MM-dd HH:mm')}. Conflict: ${JSON.stringify(conflict)}`);
            break;
          }
          console.log(`[Process Flow - ${input.senderId}] No conflicts found. Proceeding with booking.`);

          const appointmentStart = appointmentDateTime;
          const appointmentEnd = addMinutes(appointmentStart, 60); 

          const newAppointmentId = input.messageId;

          const calendarEventData: CalendarEventArgs = {
            summary: `Appt: ${finalReason} - ${input.senderName || input.senderId}`,
            description: `Patient: ${input.senderName || 'Unknown'} (${input.senderId})\nReason: ${finalReason}\nBooked via WhatsApp. WA Msg ID: ${newAppointmentId}`,
            startTime: appointmentStart.toISOString(),
            endTime: appointmentEnd.toISOString(),
          };
          console.log(`[Process Flow - ${input.senderId}] Creating calendar event:`, calendarEventData);
          const calendarEvent = await createCalendarEvent(calendarEventData);

          if (!calendarEvent || !calendarEvent.id) {
            responseText = "I'm sorry, there was an issue creating the calendar event. Please try again.";
            console.error(`[Process Flow - ${input.senderId}] Failed to create calendar event for booking. Calendar response:`, calendarEvent);
            processingErrorDetail = "Failed to create calendar event.";
            break;
          }
          console.log(`[Process Flow - ${input.senderId}] Calendar event created: ${calendarEvent.id}`);

          const appointmentData: AppointmentData = {
            id: newAppointmentId,
            patientName: input.senderName || 'Patient',
            phoneNumber: input.senderId,
            appointmentDate: format(appointmentStart, 'yyyy-MM-dd'),
            appointmentTime: format(appointmentStart, 'HH:mm'),
            reason: finalReason,
            status: 'booked',
            calendarEventId: calendarEvent.id,
            notes: `Booked via WhatsApp. Original message: "${originalMessage}"`,
          };
          console.log(`[Process Flow - ${input.senderId}] Adding appointment to sheet:`, appointmentData);
          await addAppointmentToSheet(appointmentData);
          console.log(`[Process Flow - ${input.senderId}] Appointment added to sheet.`);

          responseText = `Great! Your appointment for "${finalReason}" is confirmed for ${format(appointmentStart, 'EEEE, MMMM do, yyyy')} at ${format(appointmentStart, 'h:mm a')}. We look forward to seeing you!`;
          break;
        }

        case 'reschedule_appointment': {
          let newDateEntity = entities?.date as string;
          let newTimeEntity = entities?.time as string;
          // If only time is provided, assume date is the contextual one from AI if available, or prompt
          // This part is tricky without session state. The AI needs to provide date if it's a reschedule.
          if (newTimeEntity && !newDateEntity && entities?.contextualDate) {
              newDateEntity = entities.contextualDate;
          }


          const newDateTime = parseDateTime(newDateEntity, newTimeEntity);
          if (!newDateTime) {
            responseText = `I couldn't understand the new date or time for rescheduling (date: "${newDateEntity}", time: "${newTimeEntity}"). Please provide it clearly. If you meant to reschedule for the same day, please specify 'same day' or the date again with the new time.`;
            console.warn(`[Process Flow - ${input.senderId}] Reschedule failed: Unclear new date/time. Date entity: "${newDateEntity}", Time entity: "${newTimeEntity}"`);
            break;
          }
          if (!isFuture(newDateTime)) {
              responseText = `The new appointment time ${format(newDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
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
            responseText = `Sorry, the new time ${format(newDateTime, 'h:mm a')} is outside clinic hours (Mon-Fri, ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} - ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR -1), 'h:mm a')}). Please choose another time.`;
            break;
          }


          if (isBookingPaused) {
             try {
                const requestedDateObj = newDateTime; 
                const isPausedForRequestedDate = 
                    (pauseStartDate && pauseEndDate && isWithinInterval(requestedDateObj, { start: startOfDay(pauseStartDate), end: endOfDay(pauseEndDate) })) ||
                    (pauseStartDate && !pauseEndDate && isSameDay(requestedDateObj, pauseStartDate));
                
                if (isPausedForRequestedDate) {
                    responseText = `I'm sorry, we are not accepting new bookings or reschedules for ${format(requestedDateObj, 'MMMM do')}${pauseEndDate && !isSameDay(pauseStartDate!, pauseEndDate) ? ` (paused until ${format(pauseEndDate, 'MMMM do')})` : ''}. Please try a different date or check back later.`;
                    console.log(`[Process Flow - ${input.senderId}] Reschedule attempt for ${format(newDateTime, 'yyyy-MM-dd')} during paused period.`);
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
            if (!existingAppointment.rowIndex || !existingAppointment.calendarEventId) {
               responseText = "I found your appointment, but there's an issue with its record needed for rescheduling. Please contact the clinic directly.";
               console.error(`[Process Flow - ${input.senderId}] Patient reschedule error: Missing rowIndex (${existingAppointment.rowIndex}) or calendarEventId (${existingAppointment.calendarEventId}) for appointment ID ${existingAppointment.id}`);
               processingErrorDetail = "Patient appointment record incomplete for rescheduling.";
               break;
            }
            console.log(`[Process Flow - ${input.senderId}] Found appointment to reschedule: ID ${existingAppointment.id}, Row ${existingAppointment.rowIndex}, CalendarEventID ${existingAppointment.calendarEventId}`);

            const newStartTime = newDateTime;
            const newEndTime = addMinutes(newStartTime, 60);

            console.log(`[Process Flow - ${input.senderId}] Updating appointment in sheet (row ${existingAppointment.rowIndex}) and calendar (${existingAppointment.calendarEventId}).`);
            await updateAppointmentInSheet(existingAppointment.rowIndex, {
              appointmentDate: format(newStartTime, 'yyyy-MM-dd'),
              appointmentTime: format(newStartTime, 'HH:mm'),
              status: 'rescheduled',
              notes: `${existingAppointment.notes || ''}\nRescheduled by patient on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. Original: ${existingAppointment.appointmentDate} ${existingAppointment.appointmentTime}. WA Msg ID: ${input.messageId}`,
            });
            await updateCalendarEvent(existingAppointment.calendarEventId, {
              startTime: newStartTime.toISOString(),
              endTime: newEndTime.toISOString(),
              summary: `(RESCHEDULED) Appt: ${existingAppointment.reason} - ${existingAppointment.patientName}`,
            });
            responseText = `Your appointment has been rescheduled to ${format(newStartTime, 'EEEE, MMMM do, yyyy')} at ${format(newStartTime, 'h:mm a')}.`;
          } else { 
            const patientNameToReschedule = entities?.patient_name as string;
            if (!patientNameToReschedule) {
                responseText = "Doctor, please provide the patient name to reschedule. Format: /reschedule [Patient Name] to [YYYY-MM-DD] at [HH:MM]";
                console.warn(`[Process Flow - ${input.senderId}] Doctor reschedule failed: Missing patient name.`);
                break;
            }
            console.log(`[Process Flow - ${input.senderId}] Doctor rescheduling for patient: "${patientNameToReschedule}"`);

            const appointmentToReschedule = await findAppointment({ patientName: patientNameToReschedule, status: ['booked', 'pending_confirmation', 'rescheduled']});
            if (!appointmentToReschedule || !appointmentToReschedule.rowIndex || !appointmentToReschedule.calendarEventId) {
                responseText = `Could not find an active appointment for "${patientNameToReschedule}" to reschedule.`;
                console.warn(`[Process Flow - ${input.senderId}] Doctor reschedule failed: No appointment found for "${patientNameToReschedule}". Result: ${JSON.stringify(appointmentToReschedule)}`);
                break;
            }
            console.log(`[Process Flow - ${input.senderId}] Found appointment for "${patientNameToReschedule}" to reschedule: ID ${appointmentToReschedule.id}, Row ${appointmentToReschedule.rowIndex}, CalendarEventID ${appointmentToReschedule.calendarEventId}`);

            const newStartTime = newDateTime;
            const newEndTime = addMinutes(newStartTime, 60);

            console.log(`[Process Flow - ${input.senderId}] Updating appointment in sheet (row ${appointmentToReschedule.rowIndex}) and calendar (${appointmentToReschedule.calendarEventId}) for doctor's request.`);
            await updateAppointmentInSheet(appointmentToReschedule.rowIndex, {
                appointmentDate: format(newStartTime, 'yyyy-MM-dd'),
                appointmentTime: format(newStartTime, 'HH:mm'),
                status: 'rescheduled',
                notes: `${appointmentToReschedule.notes || ''}\nRescheduled by doctor on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}`,
            });
            await updateCalendarEvent(appointmentToReschedule.calendarEventId, {
                startTime: newStartTime.toISOString(),
                endTime: newEndTime.toISOString(),
                summary: `(RESCHEDULED by Dr.) Appt: ${appointmentToReschedule.reason} - ${appointmentToReschedule.patientName}`,
            });
            responseText = `Appointment for ${patientNameToReschedule} has been rescheduled to ${format(newStartTime, 'EEEE, MMMM do, yyyy')} at ${format(newStartTime, 'h:mm a')}. You may want to notify the patient.`;
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
             if (!appointmentToCancel.rowIndex || !appointmentToCancel.calendarEventId) {
               responseText = "I found your appointment, but there's an issue with its record needed for cancellation. Please contact the clinic directly.";
               console.error(`[Process Flow - ${input.senderId}] Patient cancel error: Missing rowIndex (${appointmentToCancel.rowIndex}) or calendarEventId (${appointmentToCancel.calendarEventId}) for appointment ID ${appointmentToCancel.id}`);
               processingErrorDetail = "Patient appointment record incomplete for cancellation.";
               break;
            }
            console.log(`[Process Flow - ${input.senderId}] Found appointment to cancel: ID ${appointmentToCancel.id}, Row ${appointmentToCancel.rowIndex}, CalendarEventID ${appointmentToCancel.calendarEventId}`);
            await updateAppointmentInSheet(appointmentToCancel.rowIndex, { status: 'cancelled', notes: `${appointmentToCancel.notes || ''}\nCancelled by patient on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}` });
            await deleteCalendarEvent(appointmentToCancel.calendarEventId);
            responseText = `Your appointment for ${appointmentToCancel.reason} on ${appointmentToCancel.appointmentDate} at ${appointmentToCancel.appointmentTime} has been cancelled.`;
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

             if (!appointmentToCancel || !appointmentToCancel.rowIndex || !appointmentToCancel.calendarEventId) {
                responseText = `Could not find an active appointment for "${patientNameToCancel}" ${specificDateToQuery ? `on ${specificDateToQuery}` : ''} to cancel.`;
                console.warn(`[Process Flow - ${input.senderId}] Doctor cancel failed: No appointment found for "${patientNameToCancel}" ${specificDateToQuery ? `on ${specificDateToQuery}` : ''}. Result: ${JSON.stringify(appointmentToCancel)}`);
                break;
            }
            console.log(`[Process Flow - ${input.senderId}] Found appointment for "${patientNameToCancel}" to cancel: ID ${appointmentToCancel.id}, Row ${appointmentToCancel.rowIndex}, CalendarEventID ${appointmentToCancel.calendarEventId}`);
            await updateAppointmentInSheet(appointmentToCancel.rowIndex, { status: 'cancelled', notes: `${appointmentToCancel.notes || ''}\nCancelled by doctor on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}` });
            await deleteCalendarEvent(appointmentToCancel.calendarEventId);
            responseText = `Appointment for ${patientNameToCancel} (${appointmentToCancel.appointmentDate} at ${appointmentToCancel.appointmentTime}) has been cancelled. You may want to notify the patient.`;
          }
          break;
        }
        
        case 'query_availability': {
          const dateForQuery = entities?.date as string;
          if (!dateForQuery) {
            responseText = "Sure, I can check availability. What date are you interested in? (e.g., 'tomorrow', 'next Monday', 'July 25th')";
          } else {
            const parsedQueryDate = parse(dateForQuery, 'yyyy-MM-dd', new Date());
            if (!isValid(parsedQueryDate)) {
              responseText = `The date "${dateForQuery}" seems invalid. Could you please provide a valid date like YYYY-MM-DD or "tomorrow"?`;
              break;
            }
            if (!isFuture(startOfDay(parsedQueryDate)) && !isSameDay(startOfDay(parsedQueryDate), startOfDay(new Date()))) {
                 responseText = `The date ${format(parsedQueryDate, 'MMMM do, yyyy')} is in the past. Please provide a current or future date for availability check.`;
                 break;
            }
             if (isBookingPaused) {
                const isPausedForQueryDate =
                    (pauseStartDate && pauseEndDate && isWithinInterval(parsedQueryDate, { start: startOfDay(pauseStartDate), end: endOfDay(pauseEndDate) })) ||
                    (pauseStartDate && !pauseEndDate && isSameDay(parsedQueryDate, pauseStartDate));
                if (isPausedForQueryDate) {
                    responseText = `I'm sorry, bookings are currently paused for ${format(parsedQueryDate, 'MMMM do')}${pauseEndDate && !isSameDay(pauseStartDate!, pauseEndDate) ? ` (paused until ${format(pauseEndDate, 'MMMM do')})` : ''}. Please try a different date.`;
                    break;
                }
            }
            const dayOfWeek = getDay(parsedQueryDate);
            if (dayOfWeek === 0 || dayOfWeek === 6) { // Sunday or Saturday
                responseText = `Sorry, the clinic is closed on weekends (${format(parsedQueryDate, 'EEEE')}). We are open Monday to Friday.`;
                break;
            }
            // For WhatsApp, listing actual free slots is complex. Guide user instead.
            responseText = `For ${format(parsedQueryDate, 'MMMM do, yyyy')}, you can try booking a specific time between ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR),'h a')} and ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR - 1),'h:mm a')}. For example, 'Book an appointment for ${format(parsedQueryDate, 'MMMM do')} at 2pm'.`;
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
                    const eventTimes = existingEvents.slice(0, 2).map(event => 
                        `${event.summary} on ${event.start?.dateTime ? format(parseISO(event.start.dateTime), 'MMM d, h:mm a') : 'N/A'}`
                    ).join(', ');
                    conflictsMessage = ` Please note: You have ${existingEvents.length} existing appointment(s) scheduled during this period (e.g., ${eventTimes}${existingEvents.length > 2 ? ' and more' : ''}). These will NOT be automatically cancelled by pausing.`;
                }

                isBookingPaused = true;
                pauseStartDate = parsedPauseStart;
                pauseEndDate = parsedPauseEnd;
                responseText = `Okay, doctor. New bookings are now paused from ${format(pauseStartDate, 'MMMM do, yyyy')} to ${format(pauseEndDate, 'MMMM do, yyyy')}.${conflictsMessage}`;
                console.log(`[Process Flow - ${input.senderId}] Bookings paused from ${format(pauseStartDate, 'yyyy-MM-dd')} to ${format(pauseEndDate, 'yyyy-MM-dd')}.${conflictsMessage ? ' Conflicts noted.' : ''}`);
            } else if (parsedPauseStart) { 
                isBookingPaused = true;
                pauseStartDate = parsedPauseStart;
                pauseEndDate = parsedPauseStart; 
                responseText = `Okay, doctor. New bookings are now paused for ${format(pauseStartDate, 'MMMM do, yyyy')}.`;
                console.log(`[Process Flow - ${input.senderId}] Bookings paused for single day: ${format(pauseStartDate, 'yyyy-MM-dd')}`);
            } else { 
                isBookingPaused = true; 
                pauseStartDate = null;  
                pauseEndDate = null;
                responseText = "Okay, doctor. New bookings are now paused indefinitely until you resume them. If you meant to pause for specific dates, please try again with the dates (e.g., '/pause bookings from YYYY-MM-DD to YYYY-MM-DD').";
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
                if (app.rowIndex && app.calendarEventId) {
                    try {
                        console.log(`[Process Flow - ${input.senderId}] Cancelling appointment ID ${app.id} (Row: ${app.rowIndex}, Calendar: ${app.calendarEventId}) for 'cancel all today'.`);
                        await updateAppointmentInSheet(app.rowIndex, { status: 'cancelled', notes: `${app.notes || ''}\nCancelled by doctor (all today) on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}`});
                        await deleteCalendarEvent(app.calendarEventId);
                        cancelledCount++;
                        patientNotifications.push(`${app.patientName} (${app.appointmentTime})`);
                    } catch (e: any) {
                        console.error(`[Process Flow - ${input.senderId}] Error cancelling appointment ID ${app.id} for 'cancel all today':`, e);
                    }
                } else {
                     console.warn(`[Process Flow - ${input.senderId}] Skipping appointment ID ${app.id} for 'cancel all today' due to missing rowIndex (${app.rowIndex}) or calendarEventId (${app.calendarEventId}).`);
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
            const {output} = await ai.generate({
              prompt: conversationalPrompt,
              model: 'googleai/gemini-2.0-flash', 
            });
            responseText = output?.text || "I'm sorry, I didn't quite understand that. I can help with booking, rescheduling, or cancelling appointments, or provide information about the clinic. How can I assist you?";
          } catch (genError: any) {
             console.error(`[Process Flow - ${input.senderId}] Error generating conversational AI response:`, genError.message || String(genError), genError.stack);
             responseText = "I'm sorry, I'm having a little trouble understanding. Could you please rephrase? You can ask me to book, reschedule, or cancel an appointment.";
             processingErrorDetail = `Conversational AI generation failed: ${genError.message || String(genError)}`;
          }
        }
      }
    } catch (flowError: any) {
      console.error(`[Process Flow - ${input.senderId}] CRITICAL ERROR in processWhatsAppMessageFlow's main try block:`, flowError.message || String(flowError), flowError.stack);
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
);

