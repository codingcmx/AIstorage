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
import {z} from 'genkit';
import {recognizeIntent, RecognizeIntentOutput} from './intent-recognition';
import { sendWhatsAppMessage } from '@/services/whatsapp-service';
import {
  addAppointmentToSheet,
  updateAppointmentInSheet,
  findAppointment,
  getAppointmentsFromSheet,
  AppointmentData,
} from '@/services/google-sheets-service';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  CalendarEventArgs,
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
  timestamp: z.date().describe('The timestamp of the incoming message.'),
});
export type ProcessWhatsAppMessageInput = z.infer<
  typeof ProcessWhatsAppMessageInputSchema
>;

const ProcessWhatsAppMessageOutputSchema = z.object({
  responseSent: z.boolean().describe('Whether a response was attempted.'),
  responseText: z.string().optional().describe('The text of the response sent or planned.'),
  intentData: RecognizeIntentOutputSchema.optional().describe('Data from intent recognition.'),
  error: z.string().optional().describe('Error message if processing failed.'),
});
export type ProcessWhatsAppMessageOutput = z.infer<
  typeof ProcessWhatsAppMessageOutputSchema
>;

// Helper to parse date and time from entities, trying various formats
function parseDateTime(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr || !timeStr) return null;
  console.log(`Attempting to parse date: "${dateStr}", time: "${timeStr}"`);

  let parsedDate: Date | null = null;

  // AI intent recognition should provide date as "YYYY-MM-DD"
  // and time as "HH:MM" (24hr) or "h:mm a".
  
  // Try parsing with specific known date and time patterns first
  const specificDateTimeFormats = [
    'yyyy-MM-dd HH:mm',    // "2024-07-25 14:00"
    'yyyy-MM-dd h:mm a',   // "2024-07-25 2:00 PM"
    'yyyy-MM-dd hh:mma',   // "2024-07-25 02:00PM" (covers "2:00pm" if AI gives that)
    'yyyy-MM-dd ha',       // "2024-07-25 2pm" (covers "2pm" if AI gives that)
  ];

  for (const fmt of specificDateTimeFormats) {
    try {
      const combinedStr = `${dateStr} ${timeStr}`;
      parsedDate = parse(combinedStr, fmt, new Date());
      if (isValid(parsedDate)) {
        console.log(`Parsed successfully with format "${fmt}":`, parsedDate);
        return parsedDate;
      }
    } catch (e) { /* ignore, try next format */ }
  }

  // Fallback for more general time expressions like "2pm" (without minutes) 
  // or "10 AM" (without minutes) when combined with a YYYY-MM-DD date.
  // This also handles cases where dateStr might not be strictly 'yyyy-MM-DD' from AI.
  try {
    let baseDate = parse(dateStr, 'yyyy-MM-dd', new Date()); // Primary attempt for AI's expected date format
    
    if (!isValid(baseDate)) {
        // Fallback if dateStr is not in 'yyyy-MM-dd' or is a more complete ISO string
        const isoDate = parseISO(dateStr); // date-fns parseISO is flexible (e.g. "2024-07-25" or "2024-07-25T10:00:00Z")
        if (isValid(isoDate)) {
            baseDate = isoDate;
            console.log(`Parsed dateStr as ISO: "${dateStr}" to:`, baseDate);
        } else {
            console.warn(`Unparseable date string: "${dateStr}" after yyyy-MM-dd and ISO attempts.`);
            return null;
        }
    }
    
    // Regex for time: e.g., "2pm", "14:30", "10:00 AM", "2 PM", "10" (for 10 AM/PM based on context)
    const timeMatch = (timeStr as string).match(/(\d{1,2})[:\.]?(\d{2})?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const minute = parseInt(timeMatch[2]) || 0; // Default to 00 if minutes are not present
      const period = timeMatch[3]?.toLowerCase();

      if (period === 'pm' && hour !== 12) hour += 12;
      if (period === 'am' && hour === 12) hour = 0; // Midnight case: 12 AM is 00 hours
      
      // Basic validation for hour and minute ranges
      if (hour >= 0 && hour <= 23 && minute >=0 && minute <= 59) {
        parsedDate = setMilliseconds(setSeconds(setMinutes(setHours(baseDate, hour), minute), 0), 0);
        if (isValid(parsedDate)) {
            console.log(`Parsed with regex fallback and setHours/Minutes on baseDate ${format(baseDate, 'yyyy-MM-dd')}:`, parsedDate);
            return parsedDate;
        }
      } else {
          console.warn(`Invalid hour/minute from regex: hour=${hour}, minute=${minute} for timeStr: "${timeStr}"`);
      }
    } else {
        console.warn(`Time string "${timeStr}" did not match regex.`);
    }
  } catch (e) {
    console.error(`Error in fallback date/time parsing for dateStr: "${dateStr}", timeStr: "${timeStr}":`, e);
  }
  
  console.warn(`Failed to parse date/time combination for date: "${dateStr}", time: "${timeStr}" using all methods.`);
  return null; // If all parsing attempts fail
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
    console.log(`[${input.senderId}] Received message: "${input.messageText}"`);
    let responseText = "I'm sorry, I'm not sure how to help with that. Please try rephrasing or ask about appointments.";
    let recognizedIntentData: RecognizeIntentOutput | undefined = undefined;
    let finalResponseSent = false;

    try {
      const isLikelyDoctor = input.messageText.startsWith('/') || (input.senderId === process.env.DOCTOR_WHATSAPP_NUMBER); // Basic check
      const senderType = isLikelyDoctor ? 'doctor' : 'patient';

      recognizedIntentData = await recognizeIntent({
        message: input.messageText,
        senderType: senderType,
      });
      const {intent, entities, originalMessage} = recognizedIntentData;
      console.log(`[${input.senderId}] Intent: ${intent}, Entities:`, JSON.stringify(entities));

      switch (intent) {
        case 'book_appointment': {
          const reason = entities.reason as string || 'Check-up';
          const appointmentDateTime = parseDateTime(entities.date as string, entities.time as string);

          if (!appointmentDateTime) {
            responseText = `I couldn't understand the date or time for your appointment (date: "${entities.date}", time: "${entities.time}"). Could you please provide them in a clearer format, like "next Monday at 2pm" or "July 25th at 10:00"? You asked for: ${reason}.`;
            break;
          }
          if (!isFuture(appointmentDateTime)) {
            responseText = `The appointment time ${format(appointmentDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
            break;
          }

          // Basic conflict check (can be enhanced)
          const existingAppointments = await getAppointmentsFromSheet({
            date: format(appointmentDateTime, 'yyyy-MM-dd'),
            status: ['booked', 'pending_confirmation']
          });
          const conflict = existingAppointments.find(app => app.appointmentTime === format(appointmentDateTime, 'HH:mm'));
          if (conflict) {
            responseText = `Sorry, the time slot ${format(appointmentDateTime, 'h:mm a')} on ${format(appointmentDateTime, 'MMMM d')} is already booked. Would you like to try another time?`;
            break;
          }

          const appointmentStart = appointmentDateTime;
          const appointmentEnd = addMinutes(appointmentStart, 60); // Default 1-hour appointments

          const newAppointmentId = input.messageId; // Use WhatsApp message ID as a unique appointment ID

          const calendarEventData: CalendarEventArgs = {
            summary: `Appt: ${reason} - ${input.senderName || input.senderId}`,
            description: `Patient: ${input.senderName || 'Unknown'} (${input.senderId})\nReason: ${reason}\nBooked via WhatsApp. WA Msg ID: ${newAppointmentId}`,
            startTime: appointmentStart.toISOString(),
            endTime: appointmentEnd.toISOString(),
          };
          const calendarEvent = await createCalendarEvent(calendarEventData);

          if (!calendarEvent || !calendarEvent.id) {
            responseText = "I'm sorry, there was an issue creating the calendar event. Please try again.";
            console.error(`[${input.senderId}] Failed to create calendar event for booking.`);
            break;
          }

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
          await addAppointmentToSheet(appointmentData);

          responseText = `Great! Your appointment for "${reason}" is confirmed for ${format(appointmentStart, 'EEEE, MMMM do, yyyy')} at ${format(appointmentStart, 'h:mm a')}. We look forward to seeing you!`;
          break;
        }

        case 'reschedule_appointment': {
          const newDateTime = parseDateTime(entities.date as string, entities.time as string);
          if (!newDateTime) {
            responseText = `I couldn't understand the new date or time for rescheduling (date: "${entities.date}", time: "${entities.time}"). Please provide it clearly.`;
            break;
          }
          if (!isFuture(newDateTime)) {
              responseText = `The new appointment time ${format(newDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
              break;
          }

          if (senderType === 'patient') {
            const existingAppointment = await findAppointment({ phoneNumber: input.senderId, status: ['booked', 'pending_confirmation', 'rescheduled'] }); // include rescheduled if they reschedule again
            if (!existingAppointment) {
              responseText = "I couldn't find an existing appointment for you to reschedule. Would you like to book a new one?";
              break;
            }
            if (!existingAppointment.rowIndex || !existingAppointment.calendarEventId) {
               responseText = "I found your appointment, but there's an issue with its record needed for rescheduling. Please contact the clinic directly.";
               console.error(`[${input.senderId}] Patient reschedule error: Missing rowIndex or calendarEventId for appointment ID ${existingAppointment.id}`);
               break;
            }
            
            const newStartTime = newDateTime;
            const newEndTime = addMinutes(newStartTime, 60);

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
            const patientNameToReschedule = entities.patient_name as string;
            if (!patientNameToReschedule) {
                responseText = "Doctor, please provide the patient name to reschedule. Format: /reschedule [Patient Name] to [YYYY-MM-DD] at [HH:MM]";
                break;
            }
            
            const appointmentToReschedule = await findAppointment({ patientName: patientNameToReschedule, status: ['booked', 'pending_confirmation', 'rescheduled']});
            if (!appointmentToReschedule || !appointmentToReschedule.rowIndex || !appointmentToReschedule.calendarEventId) {
                responseText = `Could not find an active appointment for "${patientNameToReschedule}" to reschedule.`;
                break;
            }
            
            const newStartTime = newDateTime;
            const newEndTime = addMinutes(newStartTime, 60);

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
            const appointmentToCancel = await findAppointment({ phoneNumber: input.senderId, status: ['booked', 'pending_confirmation', 'rescheduled'] });
            if (!appointmentToCancel) {
              responseText = "I couldn't find an active appointment for you to cancel.";
              break;
            }
             if (!appointmentToCancel.rowIndex || !appointmentToCancel.calendarEventId) {
               responseText = "I found your appointment, but there's an issue with its record needed for cancellation. Please contact the clinic directly.";
               console.error(`[${input.senderId}] Patient cancel error: Missing rowIndex or calendarEventId for appointment ID ${appointmentToCancel.id}`);
               break;
            }
            await updateAppointmentInSheet(appointmentToCancel.rowIndex, { status: 'cancelled', notes: `${appointmentToCancel.notes || ''}\nCancelled by patient on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}` });
            await deleteCalendarEvent(appointmentToCancel.calendarEventId);
            responseText = `Your appointment for ${appointmentToCancel.reason} on ${appointmentToCancel.appointmentDate} at ${appointmentToCancel.appointmentTime} has been cancelled.`;
          } else { // Doctor cancelling
            const patientNameToCancel = entities.patient_name as string;
            const dateToCancel = entities.date as string; // Optional date filter

            if (!patientNameToCancel) {
                responseText = "Doctor, please provide the patient name to cancel. Format: /cancel [Patient Name] appointment (optionally add 'for YYYY-MM-DD')";
                break;
            }
            const appointmentToCancel = await findAppointment({ patientName: patientNameToCancel, date: dateToCancel, status: ['booked', 'pending_confirmation', 'rescheduled'] });
             if (!appointmentToCancel || !appointmentToCancel.rowIndex || !appointmentToCancel.calendarEventId) {
                responseText = `Could not find an active appointment for "${patientNameToCancel}" ${dateToCancel ? `on ${dateToCancel}` : ''} to cancel.`;
                break;
            }
            await updateAppointmentInSheet(appointmentToCancel.rowIndex, { status: 'cancelled', notes: `${appointmentToCancel.notes || ''}\nCancelled by doctor on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}` });
            await deleteCalendarEvent(appointmentToCancel.calendarEventId);
            responseText = `Appointment for ${patientNameToCancel} (${appointmentToCancel.appointmentDate} at ${appointmentToCancel.appointmentTime}) has been cancelled. You may want to notify the patient.`;
          }
          break;
        }
        
        case 'pause_bookings':
            if (senderType !== 'doctor') { responseText = "Sorry, only doctors can pause bookings."; break; }
            const startDate = entities.start_date ? ` from ${entities.start_date}` : '';
            const endDate = entities.end_date ? ` until ${entities.end_date}` : '';
            responseText = `Okay, doctor. I will notionally pause new bookings${startDate}${endDate}. (Note: This system currently relies on direct '/resume bookings' command and does not automatically block bookings during this period without further persistent state setup).`;
            // TODO: Implement a persistent mechanism (e.g., database or specific sheet cell) to store and check this pause state.
            console.log(`[${input.senderId}] Doctor command: Pause bookings${startDate}${endDate}`);
            break;
        case 'resume_bookings':
            if (senderType !== 'doctor') { responseText = "Sorry, only doctors can resume bookings."; break; }
            responseText = "Okay, doctor. Bookings are now notionally resumed.";
            // TODO: Clear any stored pause state if implemented.
            console.log(`[${input.senderId}] Doctor command: Resume bookings`);
            break;
        case 'cancel_all_meetings_today': {
            if (senderType !== 'doctor') { responseText = "Sorry, only doctors can cancel all meetings."; break; }
            const todayStr = format(new Date(), 'yyyy-MM-dd');
            const todaysAppointments = await getAppointmentsFromSheet({ date: todayStr, status: ['booked', 'rescheduled'] }); // Cancel booked and rescheduled
            if (todaysAppointments.length === 0) {
                responseText = "Doctor, there are no booked or rescheduled appointments for today to cancel.";
                break;
            }
            let cancelledCount = 0;
            let patientNotifications: string[] = [];
            for (const app of todaysAppointments) {
                if (app.rowIndex && app.calendarEventId) {
                    try {
                        await updateAppointmentInSheet(app.rowIndex, { status: 'cancelled', notes: `${app.notes || ''}\nCancelled by doctor (all today) on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. WA Msg ID: ${input.messageId}`});
                        await deleteCalendarEvent(app.calendarEventId);
                        cancelledCount++;
                        patientNotifications.push(`${app.patientName} (${app.appointmentTime})`); 
                    } catch (e: any) {
                        console.error(`[${input.senderId}] Error cancelling appointment ID ${app.id} for 'cancel all today':`, e);
                        // Continue to next appointment
                    }
                } else {
                     console.warn(`[${input.senderId}] Skipping appointment ID ${app.id} for 'cancel all today' due to missing rowIndex or calendarEventId.`);
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
          const genericPrompt = `The user (a ${senderType}) sent: "${input.messageText}". Their intent was not specifically recognized by the booking system. Provide a helpful, polite, and concise response as a medical clinic AI assistant. If it seems like a question you can answer generally (e.g. about common cold, headache), provide a very brief, general, non-diagnostic suggestion and advise to book an appointment for specifics. If it's unclear, apologize and state you can primarily help with appointments.`;
          try {
            console.log(`[${input.senderId}] Fallback to generic AI prompt for message: "${input.messageText}"`);
            const {output} = await ai.generate({
              prompt: genericPrompt,
              model: 'googleai/gemini-2.0-flash', // Using the pre-configured model from ai.ts
            });
            responseText = output?.text || "I'm sorry, I didn't quite understand that. I can help with booking, rescheduling, or cancelling appointments. How can I assist you?";
          } catch (genError) {
             console.error(`[${input.senderId}] Error generating fallback AI response:`, genError);
             responseText = "I'm sorry, I'm having a little trouble understanding. Could you please rephrase? You can ask me to book, reschedule, or cancel an appointment.";
          }
        }
      }
    } catch (flowError: any) {
      console.error(`[${input.senderId}] Error in processWhatsAppMessageFlow:`, flowError.message || flowError, flowError.stack);
      responseText = "I'm sorry, an internal error occurred while processing your request. Please try again in a few moments. If the problem persists, please contact the clinic directly.";
      return {
        responseSent: false, 
        responseText: responseText,
        intentData: recognizedIntentData,
        error: flowError.message || String(flowError),
      };
    } finally {
      console.log(`[${input.senderId}] Sending response: "${responseText}"`);
      const sendResult = await sendWhatsAppMessage(input.senderId, responseText);
      finalResponseSent = sendResult.success;
      if (!sendResult.success) {
        console.error(`[${input.senderId}] Failed to send WhatsApp response: ${sendResult.error}`);
      }
    }

    return {
        responseSent: finalResponseSent,
        responseText: responseText,
        intentData: recognizedIntentData,
    };
  }
);

