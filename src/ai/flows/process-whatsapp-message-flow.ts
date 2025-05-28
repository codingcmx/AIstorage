
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
  parseISO
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

// Helper to parse date and time from entities, trying various formats
function parseDateTime(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr || !timeStr) {
    console.log(`[ParseDateTime] Missing dateStr ('${dateStr}') or timeStr ('${timeStr}'). Returning null.`);
    return null;
  }
  console.log(`[ParseDateTime] Attempting to parse date: "${dateStr}", time: "${timeStr}"`);

  let parsedDate: Date | null = null;

  const specificDateTimeFormats = [
    'yyyy-MM-dd HH:mm',
    'yyyy-MM-dd h:mm a',
    'yyyy-MM-dd hh:mma', // Handles "2pm"
    'yyyy-MM-dd ha',     // Handles "2a"
  ];

  for (const fmt of specificDateTimeFormats) {
    try {
      const combinedStr = `${dateStr} ${timeStr}`;
      const tempDate = parse(combinedStr, fmt, new Date());
      if (isValid(tempDate)) {
        console.log(`[ParseDateTime] Parsed successfully with format "${fmt}":`, tempDate);
        return tempDate;
      }
    } catch (e) { /* ignore, try next format */ }
  }
  console.log(`[ParseDateTime] Failed specific formats. Trying fallback for dateStr: "${dateStr}", timeStr: "${timeStr}"`);

  try {
    let baseDate = parseISO(dateStr); // Try parsing date as ISO first (e.g. from AI)
    if(!isValid(baseDate)) {
        baseDate = parse(dateStr, 'yyyy-MM-dd', new Date()); // Fallback to yyyy-MM-dd
    }

    if (!isValid(baseDate)) {
        console.warn(`[ParseDateTime] Fallback: Unparseable date string: "${dateStr}" after ISO and yyyy-MM-dd attempts.`);
        return null;
    }

    // Regex to handle various time inputs like "2pm", "14:00", "10 AM", "10:30pm"
    const timeMatch = (timeStr as string).match(/(\d{1,2})[:\.]?(\d{2})?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const period = timeMatch[3]?.toLowerCase();

      if (period === 'pm' && hour < 12) hour += 12;
      if (period === 'am' && hour === 12) hour = 0; // Midnight case

      if (hour >= 0 && hour <= 23 && minute >=0 && minute <= 59) {
        parsedDate = setMilliseconds(setSeconds(setMinutes(setHours(baseDate, hour), minute), 0), 0);
        if (isValid(parsedDate)) {
            console.log(`[ParseDateTime] Fallback: Parsed with regex on baseDate ${format(baseDate, 'yyyy-MM-dd')}:`, parsedDate);
            return parsedDate;
        } else {
            console.warn(`[ParseDateTime] Fallback: Resulting date from setHours/Minutes is invalid. Base: ${baseDate}, H:${hour}, M:${minute}`);
        }
      } else {
          console.warn(`[ParseDateTime] Fallback: Invalid hour/minute from regex: hour=${hour}, minute=${minute} for timeStr: "${timeStr}"`);
      }
    } else {
        console.warn(`[ParseDateTime] Fallback: Time string "${timeStr}" did not match regex.`);
    }
  } catch (e) {
    console.error(`[ParseDateTime] Fallback: Error in fallback date/time parsing for dateStr: "${dateStr}", timeStr: "${timeStr}":`, e);
  }

  console.warn(`[ParseDateTime] Failed to parse date/time combination for date: "${dateStr}", time: "${timeStr}" using all methods. Returning null.`);
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
    const messageReceivedDate = parseISO(input.timestamp);
    if (!isValid(messageReceivedDate)) {
      const timestampError = `[Process Flow - ${input.senderId}] CRITICAL: Invalid timestamp received: "${input.timestamp}". Cannot process message.`;
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
      const {intent, entities, originalMessage} = recognizedIntentData;
      console.log(`[Process Flow - ${input.senderId}] Intent: ${intent}, Entities:`, JSON.stringify(entities), `Original: "${originalMessage}"`);

      switch (intent) {
        case 'book_appointment': {
          const reason = entities?.reason as string || 'Check-up';
          const appointmentDateTime = parseDateTime(entities?.date as string, entities?.time as string);

          if (!appointmentDateTime) {
            responseText = `I couldn't understand the date or time for your appointment (parsed date: "${entities?.date}", time: "${entities?.time}"). Could you please provide them in a clearer format, like "next Monday at 2pm" or "July 25th at 10:00"? You asked for: ${reason}.`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Unclear date/time. Date entity: "${entities?.date}", Time entity: "${entities?.time}"`);
            break;
          }
          if (!isFuture(appointmentDateTime)) {
            responseText = `The appointment time ${format(appointmentDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Past date/time. Parsed: ${appointmentDateTime}`);
            break;
          }

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
            responseText = `Sorry, the time slot ${format(appointmentDateTime, 'h:mm a')} on ${format(appointmentDateTime, 'MMMM d')} is already booked. Would you like to try another time?`;
            console.warn(`[Process Flow - ${input.senderId}] Booking failed: Conflict found for ${format(appointmentDateTime, 'yyyy-MM-dd HH:mm')}. Conflict: ${JSON.stringify(conflict)}`);
            break;
          }
          console.log(`[Process Flow - ${input.senderId}] No conflicts found. Proceeding with booking.`);

          const appointmentStart = appointmentDateTime;
          const appointmentEnd = addMinutes(appointmentStart, 60); // Assuming 1-hour appointments

          const newAppointmentId = input.messageId; // Use WhatsApp message ID as appointment ID

          const calendarEventData: CalendarEventArgs = {
            summary: `Appt: ${reason} - ${input.senderName || input.senderId}`,
            description: `Patient: ${input.senderName || 'Unknown'} (${input.senderId})\nReason: ${reason}\nBooked via WhatsApp. WA Msg ID: ${newAppointmentId}`,
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
            reason: reason,
            status: 'booked',
            calendarEventId: calendarEvent.id,
            notes: `Booked via WhatsApp. Original message: "${originalMessage}"`,
          };
          console.log(`[Process Flow - ${input.senderId}] Adding appointment to sheet:`, appointmentData);
          await addAppointmentToSheet(appointmentData);
          console.log(`[Process Flow - ${input.senderId}] Appointment added to sheet.`);

          responseText = `Great! Your appointment for "${reason}" is confirmed for ${format(appointmentStart, 'EEEE, MMMM do, yyyy')} at ${format(appointmentStart, 'h:mm a')}. We look forward to seeing you!`;
          break;
        }

        case 'reschedule_appointment': {
          const newDateTime = parseDateTime(entities?.date as string, entities?.time as string);
          if (!newDateTime) {
            responseText = `I couldn't understand the new date or time for rescheduling (date: "${entities?.date}", time: "${entities?.time}"). Please provide it clearly.`;
            console.warn(`[Process Flow - ${input.senderId}] Reschedule failed: Unclear new date/time. Date entity: "${entities?.date}", Time entity: "${entities?.time}"`);
            break;
          }
          if (!isFuture(newDateTime)) {
              responseText = `The new appointment time ${format(newDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
              console.warn(`[Process Flow - ${input.senderId}] Reschedule failed: Past new date/time. Parsed: ${newDateTime}`);
              break;
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
          } else { // Doctor rescheduling
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
          } else { // Doctor cancelling
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

        case 'pause_bookings':
            if (senderType !== 'doctor') {
                responseText = "Sorry, only doctors can pause bookings.";
                console.warn(`[Process Flow - ${input.senderId}] Unauthorized attempt to pause bookings by non-doctor.`);
                break;
            }
            const startDate = entities?.start_date ? ` from ${entities.start_date}` : '';
            const endDate = entities?.end_date ? ` until ${entities.end_date}` : '';
            responseText = `Okay, doctor. I will notionally pause new bookings${startDate}${endDate}. (Note: This system currently relies on direct '/resume bookings' command and does not automatically block bookings during this period without further persistent state setup).`;
            console.log(`[Process Flow - ${input.senderId}] Doctor command: Pause bookings${startDate}${endDate}. This is a notional pause.`);
            break;
        case 'resume_bookings':
            if (senderType !== 'doctor') {
                responseText = "Sorry, only doctors can resume bookings.";
                console.warn(`[Process Flow - ${input.senderId}] Unauthorized attempt to resume bookings by non-doctor.`);
                break;
            }
            responseText = "Okay, doctor. Bookings are now notionally resumed.";
            console.log(`[Process Flow - ${input.senderId}] Doctor command: Resume bookings. This is a notional resumption.`);
            break;
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
          responseText = "The clinic is open from 9 AM to 5 PM, Monday to Friday. We are closed on weekends and public holidays.";
          break;
        case 'other':
        default: {
          const conversationalPrompt = `You are MediMate AI, a friendly and helpful WhatsApp assistant for Dr. [Doctor's Name]'s clinic.
The user (a ${senderType}) sent: "${input.messageText}".
Your primary functions are to help with booking, rescheduling, or cancelling appointments. You can also answer simple questions about the clinic like opening hours.
If the user's message seems related to these functions, guide them or ask for clarification.
If the message is a general health query, provide a very brief, general, non-diagnostic piece of advice and strongly recommend booking an appointment for any medical concerns. Do NOT attempt to diagnose or give specific medical advice.
If the message is a simple greeting or social interaction, respond politely and conversationally.
If the message is completely unrelated or very unclear, politely state that you can primarily assist with appointments and clinic information.
Keep your responses concise and helpful.`;
          try {
            console.log(`[Process Flow - ${input.senderId}] Fallback to conversational AI prompt for message: "${input.messageText}"`);
            const {output} = await ai.generate({ 
              prompt: conversationalPrompt,
              model: ai.getModel(), 
            });
            responseText = output?.text || "I'm sorry, I didn't quite understand that. I can help with booking, rescheduling, or cancelling appointments, or provide information about the clinic. How can I assist you?";
          } catch (genError: any) {
             console.error(`[Process Flow - ${input.senderId}] Error generating conversational AI response:`, genError);
             responseText = "I'm sorry, I'm having a little trouble understanding. Could you please rephrase? You can ask me to book, reschedule, or cancel an appointment.";
          }
        }
      }
    } catch (flowError: any) {
      console.error(`[Process Flow - ${input.senderId}] CRITICAL ERROR in processWhatsAppMessageFlow's main try block:`, flowError.message || String(flowError), flowError.stack);
      responseText = "I'm sorry, an internal error occurred while processing your request. Please try again in a few moments. If the problem persists, please contact the clinic directly.";
      processingErrorDetail = flowError.message || String(flowError); 
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
