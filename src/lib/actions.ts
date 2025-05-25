
"use server";

import type { SenderType } from '@/types/chat';
// We keep recognizeIntent here for the web UI, but WhatsApp flow uses it directly.
import { recognizeIntent } from '@/ai/flows/intent-recognition';
import { generateDailySummary, GenerateDailySummaryInput } from '@/ai/flows/daily-summary';
import { getAppointmentsFromSheet } from '@/services/google-sheets-service';
import { format } from 'date-fns';


interface HandleUserMessageResult {
  responseText: string;
  intent?: string;
  entities?: Record<string, any>;
}

export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  // This function is now primarily for the web UI.
  // WhatsApp messages are handled by the webhook and processWhatsAppMessageFlow.
  try {
    // For the web UI, we'll use the existing intent recognition and simulate responses.
    // Actual booking/management for WhatsApp happens in its dedicated flow.

    const { intent, entities } = await recognizeIntent({ message: messageText, senderType });

    let responseText = "I'm not sure how to help with that. Can you try rephrasing?";

    switch (intent) {
      case 'book_appointment':
        responseText = `Okay, I'll help you book an appointment.`;
        if (entities.reason) responseText += ` Reason: ${entities.reason}.`;
        if (entities.date) responseText += ` Date: ${entities.date}.`;
        if (entities.time) responseText += ` Time: ${entities.time}.`;
        responseText += `\n\n(Simulated for web UI) Please confirm these details or provide any missing information. For actual booking, please use WhatsApp.`;
        break;
      case 'reschedule_appointment':
        responseText = `Sure, I can help you reschedule.`;
        if (entities.date) responseText += ` New date: ${entities.date}.`;
        if (entities.time) responseText += ` New time: ${entities.time}.`;
        responseText += `\n\n(Simulated for web UI) Is this correct? For actual rescheduling, please use WhatsApp.`;
        break;
      case 'cancel_appointment':
         if (senderType === 'doctor' && entities.patient_name) {
            responseText = `(Simulated for web UI) Appointment for patient ${entities.patient_name} would be cancelled. For actual cancellation, please use WhatsApp.`;
        } else {
            responseText = "(Simulated for web UI) Your appointment would be cancelled. For actual cancellation, please use WhatsApp.";
        }
        break;
      case 'pause_bookings':
        responseText = `(Simulated for web UI) Bookings would be paused.`;
        if (entities.date) responseText += ` Until: ${entities.date}.`;
        responseText += ` For actual pausing, doctor should use WhatsApp commands.`;
        break;
      case 'resume_bookings':
        responseText = "(Simulated for web UI) Bookings would be resumed. For actual resumption, doctor should use WhatsApp commands.";
        break;
      case 'cancel_all_meetings_today':
        responseText = "(Simulated for web UI) All meetings for today would be cancelled. For actual command, doctor should use WhatsApp.";
        break;
      case 'greeting':
        responseText = "Hello! How can I help you today? (Web UI)";
        break;
      case 'thank_you':
        responseText = "You're welcome! (Web UI)";
        break;
      case 'faq_opening_hours':
        responseText = "The clinic is open from 9 AM to 5 PM, Monday to Friday.";
        break;
      default:
         const {output} = await ai.generate({ // ai object is not defined here, needs to be imported or passed if used.
            prompt: `The user sent: "${messageText}". Provide a helpful, concise, and generic response as a medical clinic AI assistant, as their specific intent was not recognized by the system. This is for a web UI test.`,
         });
        responseText = output?.text || "I'm sorry, I didn't quite understand that. Could you please rephrase? (Web UI)";
    }

    return { responseText, intent, entities };

  } catch (error) {
    console.error("Error in handleUserMessage (web UI):", error);
    return { responseText: "Sorry, I encountered an error (Web UI). Please try again." };
  }
}

export async function getDailySummaryAction(): Promise<string> {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    const appointmentsFromSheet = await getAppointmentsFromSheet(today);


    if (!appointmentsFromSheet || appointmentsFromSheet.length === 0) {
        return "No appointments scheduled for today.";
    }

    const formattedAppointments: GenerateDailySummaryInput['appointments'] = appointmentsFromSheet
      .filter(app => app.status === 'booked') // Ensure we only summarize booked appointments
      .map(app => ({
          patientName: app.patientName,
          time: app.appointmentTime, // Assuming appointmentTime is already formatted like "10:00 AM" or "14:00"
          reason: app.reason,
    }));

    if (formattedAppointments.length === 0) {
        return "No booked appointments scheduled for today.";
    }

    const { summary } = await generateDailySummary({ appointments: formattedAppointments });
    return summary;
  } catch (error) {
    console.error("Error in getDailySummaryAction:", error);
    // Check if error is an object and has a message property
    const errorMessage = (typeof error === 'object' && error !== null && 'message' in error) 
                         ? (error as Error).message 
                         : 'Unknown error';
    return `Sorry, I couldn't fetch the daily summary due to an error: ${errorMessage}`;
  }
}
