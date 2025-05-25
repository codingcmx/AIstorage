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

  let parsedDate: Date | null = null;
  const commonDateFormats = ['yyyy-MM-dd', 'MM/dd/yyyy', 'dd/MM/yyyy', 'MM-dd-yyyy', 'yyyy/MM/dd'];
  const commonTimeFormatsWithDate = ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd h:mm a', 'yyyy-MM-dd hh:mma', 'yyyy-MM-dd ha'];

  // Try combining date and time first
  for (const fmt of commonTimeFormatsWithDate) {
    try {
      const combinedStr = `${dateStr} ${timeStr}`;
      parsedDate = parse(combinedStr, fmt.replace('yyyy-MM-dd', commonDateFormats[0]), new Date()); // Use a base date format
      if (isValid(parsedDate)) break;
    } catch (e) { /* ignore */ }
  }
  
  // If combined parsing failed, parse date and time separately
  if (!parsedDate || !isValid(parsedDate)) {
    let baseDate: Date | null = null;
    for (const fmt of commonDateFormats) {
        try {
            baseDate = parse(dateStr, fmt, new Date());
            if (isValid(baseDate)) break;
        } catch (e) { /* ignore */ }
    }

    if (!baseDate || !isValid(baseDate)) {
        // Try ISO date parsing as a fallback for dateStr
        baseDate = parseISO(dateStr);
        if (!isValid(baseDate)) return null; // Date is unparsable
    }
    
    // Parse time string (e.g., "2pm", "14:30", "10:00 AM")
    const timeMatch = (timeStr as string).match(/(\d{1,2})[:\.]?(\d{2})?\s?(am|pm)?/i);
    if (timeMatch) {
        let hour = parseInt(timeMatch[1]);
        const minute = parseInt(timeMatch[2]) || 0;
        const period = timeMatch[3]?.toLowerCase();

        if (period === 'pm' && hour !== 12) hour += 12;
        if (period === 'am' && hour === 12) hour = 0; // Midnight case: 12 AM is 00 hours
        if (hour > 23) return null; // Invalid hour

        parsedDate = setMilliseconds(setSeconds(setMinutes(setHours(baseDate, hour), minute),0),0);
    } else {
        return null; // Time is unparsable
    }
  }
  
  return isValid(parsedDate) ? parsedDate : null;
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
      console.log(`[${input.senderId}] Intent: ${intent}, Entities:`, entities);

      switch (intent) {
        case 'book_appointment': {
          const reason = entities.reason as string || 'Check-up';
          const appointmentDateTime = parseDateTime(entities.date as string, entities.time as string);

          if (!appointmentDateTime) {
            responseText = `I couldn't understand the date or time for your appointment ("${entities.date} ${entities.time}"). Could you please provide them in a clearer format, like "next Monday at 2pm" or "July 25th at 10:00"? You asked for: ${reason}.`;
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
          // For patient rescheduling
          if (senderType === 'patient') {
            const existingAppointment = await findAppointment({ phoneNumber: input.senderId, status: ['booked', 'pending_confirmation'] });
            if (!existingAppointment) {
              responseText = "I couldn't find an existing appointment for you to reschedule. Would you like to book a new one?";
              break;
            }
            if (!existingAppointment.rowIndex || !existingAppointment.calendarEventId) {
               responseText = "I found your appointment, but there's an issue with its record needed for rescheduling. Please contact the clinic directly.";
               break;
            }

            const newDateTime = parseDateTime(entities.date as string, entities.time as string);
            if (!newDateTime) {
              responseText = `I couldn't understand the new date or time for rescheduling ("${entities.date} ${entities.time}"). Please provide it clearly. Your current appointment is on ${existingAppointment.appointmentDate} at ${existingAppointment.appointmentTime}.`;
              break;
            }
            if (!isFuture(newDateTime)) {
                responseText = `The new appointment time ${format(newDateTime, 'MMM d, yyyy h:mm a')} is in the past. Please choose a future time.`;
                break;
            }
            
            const newStartTime = newDateTime;
            const newEndTime = addMinutes(newStartTime, 60);

            await updateAppointmentInSheet(existingAppointment.rowIndex, {
              appointmentDate: format(newStartTime, 'yyyy-MM-DD'),
              appointmentTime: format(newStartTime, 'HH:mm'),
              status: 'rescheduled',
              notes: `${existingAppointment.notes || ''}\nRescheduled by patient on ${format(new Date(), 'yyyy-MM-dd HH:mm')}. Original: ${existingAppointment.appointmentDate} ${existingAppointment.appointmentTime}.`,
            });
            await updateCalendarEvent(existingAppointment.calendarEventId, {
              startTime: newStartTime.toISOString(),
              endTime: newEndTime.toISOString(),
              summary: `(RESCHEDULED) Appt: ${existingAppointment.reason} - ${existingAppointment.patientName}`,
            });
            responseText = `Your appointment has been rescheduled to ${format(newStartTime, 'EEEE, MMMM do, yyyy')} at ${format(newStartTime, 'h:mm a')}.`;
          } else { // Doctor rescheduling
            const patientNameToReschedule = entities.patient_name as string;
            const newDate = entities.date as string;
            const newTime = entities.time as string;

            if (!patientNameToReschedule || !newDate || !newTime) {
                responseText = "Doctor, please provide patient name, new date, and new time to reschedule. Format: /reschedule [Patient Name] to [YYYY-MM-DD] at [HH:MM]";
                break;
            }
            const newDateTime = parseDateTime(newDate, newTime);
            if (!newDateTime || !isFuture(newDateTime)) {
                responseText = `Invalid new date/time for ${patientNameToReschedule}. Please use a valid future date/time.`;
                break;
            }

            const appointmentToReschedule = await findAppointment({ patientName: patientNameToReschedule, status: ['booked', 'pending_confirmation']});
            if (!appointmentToReschedule || !appointmentToReschedule.rowIndex || !appointmentToReschedule.calendarEventId) {
                responseText = `Could not find an active appointment for "${patientNameToReschedule}" to reschedule.`;
                break;
            }
            
            const newStartTime = newDateTime;
            const newEndTime = addMinutes(newStartTime, 60);

            await updateAppointmentInSheet(appointmentToReschedule.rowIndex, {
                appointmentDate: format(newStartTime, 'yyyy-MM-DD'),
                appointmentTime: format(newStartTime, 'HH:mm'),
                status: 'rescheduled',
                notes: `${appointmentToReschedule.notes || ''}\nRescheduled by doctor on ${format(new Date(), 'yyyy-MM-dd HH:mm')}.`,
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
            const appointmentToCancel = await findAppointment({ phoneNumber: input.senderId, status: ['booked', 'pending_confirmation'] });
            if (!appointmentToCancel) {
              responseText = "I couldn't find an active appointment for you to cancel.";
              break;
            }
             if (!appointmentToCancel.rowIndex || !appointmentToCancel.calendarEventId) {
               responseText = "I found your appointment, but there's an issue with its record needed for cancellation. Please contact the clinic directly.";
               break;
            }
            await updateAppointmentInSheet(appointmentToCancel.rowIndex, { status: 'cancelled', notes: `${appointmentToCancel.notes || ''}\nCancelled by patient on ${format(new Date(), 'yyyy-MM-dd HH:mm')}.` });
            await deleteCalendarEvent(appointmentToCancel.calendarEventId);
            responseText = `Your appointment for ${appointmentToCancel.reason} on ${appointmentToCancel.appointmentDate} at ${appointmentToCancel.appointmentTime} has been cancelled.`;
          } else { // Doctor cancelling
            const patientNameToCancel = entities.patient_name as string;
            const dateToCancel = entities.date as string; // Optional date filter

            if (!patientNameToCancel) {
                responseText = "Doctor, please provide the patient name to cancel. Format: /cancel [Patient Name] appointment (optionally add 'for YYYY-MM-DD')";
                break;
            }
            const appointmentToCancel = await findAppointment({ patientName: patientNameToCancel, date: dateToCancel, status: ['booked', 'pending_confirmation'] });
             if (!appointmentToCancel || !appointmentToCancel.rowIndex || !appointmentToCancel.calendarEventId) {
                responseText = `Could not find an active appointment for "${patientNameToCancel}" ${dateToCancel ? `on ${dateToCancel}` : ''} to cancel.`;
                break;
            }
            await updateAppointmentInSheet(appointmentToCancel.rowIndex, { status: 'cancelled', notes: `${appointmentToCancel.notes || ''}\nCancelled by doctor on ${format(new Date(), 'yyyy-MM-dd HH:mm')}.` });
            await deleteCalendarEvent(appointmentToCancel.calendarEventId);
            responseText = `Appointment for ${patientNameToCancel} (${appointmentToCancel.appointmentDate} at ${appointmentToCancel.appointmentTime}) has been cancelled. You may want to notify the patient.`;
          }
          break;
        }
        
        // Doctor commands
        case 'pause_bookings':
            if (senderType !== 'doctor') { responseText = "Sorry, only doctors can pause bookings."; break; }
            // For now, this is just an acknowledgement. True pause requires persistent state.
            const startDate = entities.start_date ? ` from ${entities.start_date}` : '';
            const endDate = entities.end_date ? ` until ${entities.end_date}` : '';
            responseText = `Okay, doctor. I will notionally pause new bookings${startDate}${endDate}. Patients will be informed if they try to book. (Note: Full automated pausing requires further setup).`;
            // TODO: Implement a mechanism to store and check this pause state.
            break;
        case 'resume_bookings':
            if (senderType !== 'doctor') { responseText = "Sorry, only doctors can resume bookings."; break; }
            responseText = "Okay, doctor. Bookings are now notionally resumed. (Note: Full automated resuming requires further setup).";
            // TODO: Clear any stored pause state.
            break;
        case 'cancel_all_meetings_today': {
            if (senderType !== 'doctor') { responseText = "Sorry, only doctors can cancel all meetings."; break; }
            const todayStr = format(new Date(), 'yyyy-MM-dd');
            const todaysAppointments = await getAppointmentsFromSheet({ date: todayStr, status: 'booked' });
            if (todaysAppointments.length === 0) {
                responseText = "Doctor, there are no booked appointments for today to cancel.";
                break;
            }
            let cancelledCount = 0;
            let patientNotifications: string[] = [];
            for (const app of todaysAppointments) {
                if (app.rowIndex && app.calendarEventId) {
                    await updateAppointmentInSheet(app.rowIndex, { status: 'cancelled', notes: `${app.notes || ''}\nCancelled by doctor (all today) on ${format(new Date(), 'yyyy-MM-dd HH:mm')}.`});
                    await deleteCalendarEvent(app.calendarEventId);
                    cancelledCount++;
                    // Prepare notification for patient (send individually or summarize for doctor)
                    // For now, just list them in the response to the doctor.
                    patientNotifications.push(`${app.patientName} (${app.appointmentTime})`); 
                }
            }
            if (cancelledCount > 0) {
                responseText = `Okay, doctor. Cancelled ${cancelledCount} appointment(s) for today: ${patientNotifications.join(', ')}. You may want to notify them individually if the system doesn't.`;
            } else {
                responseText = "Doctor, I found appointments for today but encountered issues cancelling them. Please check the logs or Google Sheet/Calendar.";
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
          // Fallback to a generic AI response
          const genericPrompt = `The user (a ${senderType}) sent: "${input.messageText}". Their intent was not specifically recognized by the booking system. Provide a helpful, polite, and concise response as a medical clinic AI assistant. If it seems like a question you can answer generally (e.g. about common cold, headache), provide a very brief, general, non-diagnostic suggestion and advise to book an appointment for specifics. If it's unclear, apologize and state you can primarily help with appointments.`;
          try {
            const {output} = await ai.generate({
              prompt: genericPrompt,
              model: 'googleai/gemini-2.0-flash',
            });
            responseText = output?.text || "I'm sorry, I didn't quite understand that. I can help with booking, rescheduling, or cancelling appointments. How can I assist you?";
          } catch (genError) {
             console.error("Error generating fallback AI response:", genError);
             responseText = "I'm sorry, I'm having a little trouble understanding. Could you please rephrase? You can ask me to book, reschedule, or cancel an appointment.";
          }
        }
      }
    } catch (flowError: any) {
      console.error(`[${input.senderId}] Error in processWhatsAppMessageFlow:`, flowError);
      responseText = "I'm sorry, an internal error occurred while processing your request. Please try again in a few moments. If the problem persists, please contact the clinic directly.";
      // Optionally, send a more detailed error to a monitoring service or admin
      return {
        responseSent: false, // Will be attempted by finally block
        responseText: responseText, // The user-facing error
        intentData: recognizedIntentData,
        error: flowError.message || String(flowError),
      };
    } finally {
      // Always attempt to send a response
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
