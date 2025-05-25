// src/ai/flows/process-whatsapp-message-flow.ts
'use server';
/**
 * @fileOverview Processes incoming WhatsApp messages, recognizes intent,
 * performs actions (like booking), and generates a response.
 *
 * - processWhatsAppMessage - Main function to handle WhatsApp messages.
 * - ProcessWhatsAppMessageInput - Input type for the flow.
 * - ProcessWhatsAppMessageOutput - Output type (currently void, response sent via WhatsApp service).
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import {recognizeIntent, RecognizeIntentOutput} from './intent-recognition';
import {
  sendWhatsAppMessage,
} from '@/services/whatsapp-service';
import { addAppointmentToSheet, AppointmentData } from '@/services/google-sheets-service';
import { createCalendarEvent, CalendarEventArgs } from '@/services/google-calendar-service';
import { format, parse, addMinutes, setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';


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

// For now, the flow doesn't explicitly return output via this channel,
// as responses are sent directly via the WhatsApp service.
// This could be changed to return the planned response text for logging or other purposes.
const ProcessWhatsAppMessageOutputSchema = z.object({
  responseSent: z.boolean().describe('Whether a response was attempted.'),
  responseText: z.string().optional().describe('The text of the response sent or planned.'),
  intentData: RecognizeIntentOutputSchema.optional().describe('Data from intent recognition.'),
});
export type ProcessWhatsAppMessageOutput = z.infer<
  typeof ProcessWhatsAppMessageOutputSchema
>;


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
  async (input: ProcessWhatsAppMessageInput) => {
    console.log('Processing WhatsApp message in flow:', input);

    let responseText = "I'm not sure how to help with that. Can you try rephrasing?";
    let recognizedIntentData: RecognizeIntentOutput | undefined = undefined;

    try {
      // 1. Recognize Intent
      // Determine sender type based on whether it's the doctor's number (needs configuration)
      // For now, let's assume messages are from patients unless a doctor command is detected.
      // A more robust way would be to have a list of doctor numbers or use the senderName.
      const isDoctorCommand = /^\/(pause|resume|cancel|reschedule)/.test(input.messageText.toLowerCase());
      const senderType = isDoctorCommand ? 'doctor' : 'patient';

      recognizedIntentData = await recognizeIntent({
        message: input.messageText,
        senderType: senderType,
      });
      const {intent, entities} = recognizedIntentData;
      console.log(`Intent: ${intent}, Entities:`, entities);


      // 2. Perform Actions based on Intent & Entities
      switch (intent) {
        case 'book_appointment':
          // Basic example: Assume entities contain date, time, reason
          if (entities.date && entities.time && entities.reason) {
            const appointmentDateTimeStr = `${entities.date} ${entities.time}`; // e.g., "2024-07-10 14:00"
            let appointmentStart: Date;
            try {
                // Try parsing common formats, adjust as needed
                appointmentStart = parse(appointmentDateTimeStr, 'yyyy-MM-dd HH:mm', new Date());
                 if (isNaN(appointmentStart.getTime())) {
                    appointmentStart = parse(appointmentDateTimeStr, 'yyyy-MM-dd h:mm a', new Date());
                 }
                 if (isNaN(appointmentStart.getTime())) {
                    // attempt to parse just date if time is not standard
                    appointmentStart = parse(entities.date, 'yyyy-MM-dd', new Date());
                    // If time is something like "2pm", try to parse and set
                    const timeMatch = (entities.time as string).match(/(\d{1,2})[:\.]?(\d{2})?\s?(am|pm)?/i);
                    if (timeMatch) {
                        let hour = parseInt(timeMatch[1]);
                        const minute = parseInt(timeMatch[2]) || 0;
                        const period = timeMatch[3]?.toLowerCase();
                        if (period === 'pm' && hour < 12) hour += 12;
                        if (period === 'am' && hour === 12) hour = 0; // Midnight case
                        appointmentStart = setHours(appointmentStart, hour);
                        appointmentStart = setMinutes(appointmentStart, minute);
                    } else {
                         throw new Error('Invalid time format in booking');
                    }
                 }
                 appointmentStart = setSeconds(appointmentStart, 0);
                 appointmentStart = setMilliseconds(appointmentStart, 0);

            } catch (e) {
                console.error("Error parsing appointment date/time:", e);
                responseText = `I couldn't understand the date or time: ${entities.date} ${entities.time}. Please use YYYY-MM-DD and HH:MM format (e.g., 2024-07-15 14:30).`;
                break;
            }


            const appointmentEnd = addMinutes(appointmentStart, 60); // Assume 1-hour appointments

            const appointmentData: AppointmentData = {
              patientName: input.senderName || 'Unknown Patient',
              phoneNumber: input.senderId,
              appointmentDate: format(appointmentStart, 'yyyy-MM-dd'),
              appointmentTime: format(appointmentStart, 'HH:mm'),
              reason: entities.reason as string,
              status: 'booked',
              notes: `Booked via WhatsApp by ${input.senderName || input.senderId}`,
            };
            await addAppointmentToSheet(appointmentData);

            const calendarEvent: CalendarEventArgs = {
              summary: `Appointment: ${entities.reason} - ${input.senderName || input.senderId}`,
              description: `Patient: ${input.senderName || input.senderId} (${input.senderId})\nReason: ${entities.reason}\nBooked via WhatsApp.`,
              startTime: appointmentStart.toISOString(),
              endTime: appointmentEnd.toISOString(),
            };
            await createCalendarEvent(calendarEvent);

            responseText = `Appointment confirmed for ${entities.reason} on ${format(appointmentStart, 'EEEE, MMMM do')} at ${format(appointmentStart, 'h:mm a')}. See you then!`;
          } else {
            responseText = "To book an appointment, please provide the date, time, and reason for your visit. For example: 'Book appointment for tooth cleaning on 2024-07-15 at 2:30 PM'";
          }
          break;

        case 'reschedule_appointment':
          // TODO: Implement reschedule logic (find existing, update GSheet & GCal)
          responseText = `Okay, I'll help you reschedule. Currently, this feature is under development. Please contact the clinic directly.`;
          if (entities.patient_name && entities.date && entities.time) {
             responseText = `Reschedule request for ${entities.patient_name} to ${entities.date} at ${entities.time}. This feature is under development.`;
          }
          break;

        case 'cancel_appointment':
          // TODO: Implement cancel logic (find existing, update GSheet & GCal)
          responseText = "Your appointment cancellation request is being processed. This feature is under development. Please contact the clinic directly.";
          if (senderType === 'doctor' && entities.patient_name) {
             responseText = `Request to cancel appointment for ${entities.patient_name}. This feature is under development.`;
          }
          break;
        
        // Doctor commands
        case 'pause_bookings':
            // TODO: Implement pause logic (e.g. store pause dates in Firestore or a config sheet)
            responseText = `Okay, doctor. I will pause new bookings.`;
            if (entities.start_date && entities.end_date) {
                responseText += ` From ${entities.start_date} to ${entities.end_date}.`;
            } else if (entities.date) { // assuming 'date' entity can be 'today' or a specific date for pausing from
                 responseText += ` Starting from ${entities.date}.`;
            }
            responseText += `\nThis feature is under development for full automation.`;
            break;
        case 'resume_bookings':
            // TODO: Implement resume logic
            responseText = "Okay, doctor. Bookings are now resumed. This feature is under development for full automation.";
            break;
        case 'cancel_all_meetings_today':
            // TODO: Implement cancel all today (fetch from GCal/GSheet, update, notify patients)
            responseText = "Okay, doctor. I will cancel all meetings for today. This feature is under development for full automation.";
            break;

        case 'greeting':
          responseText = "Hello! I'm MediMate AI. How can I assist you with your appointment today?";
          break;
        case 'thank_you':
          responseText = "You're welcome! Is there anything else?";
          break;
        case 'faq_opening_hours':
          responseText = "The clinic is open from 9 AM to 5 PM, Monday to Friday.";
          break;
        default:
          // Use the default "I'm not sure" or a more general AI response
          const {output} = await ai.generate({
            prompt: `The user sent: "${input.messageText}". Provide a helpful, concise, and generic response as a medical clinic AI assistant, as their specific intent was not recognized by the system. If it seems like a question, try to answer it generally or state you cannot help with specifics yet.`,
            model: 'googleai/gemini-2.0-flash', // or your preferred model
          });
          responseText = output?.text || "I'm sorry, I didn't quite understand that. Could you please rephrase or ask about appointments?";
      }
    } catch (flowError) {
      console.error('Error in processWhatsAppMessageFlow:', flowError);
      responseText = "I'm sorry, an internal error occurred while processing your request. Please try again later.";
    }

    // 3. Send Response via WhatsApp
    const sendResult = await sendWhatsAppMessage(input.senderId, responseText);
    if (!sendResult.success) {
      console.error(`Failed to send WhatsApp response to ${input.senderId}: ${sendResult.error}`);
    }

    return {
        responseSent: sendResult.success,
        responseText: responseText,
        intentData: recognizedIntentData
    };
  }
);
