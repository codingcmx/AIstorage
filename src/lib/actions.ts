
"use server";

import type { SenderType } from '@/types/chat';
import { recognizeIntent } from '@/ai/flows/intent-recognition'; // Kept for web UI testing
import { generateDailySummary, GenerateDailySummaryInput } from '@/ai/flows/daily-summary';
import { getAppointmentsFromSheet } from '@/services/google-sheets-service';
import { format } from 'date-fns';
import { ai } from '@/ai/genkit'; // Import the global Genkit ai object for fallback generation


interface HandleUserMessageResult {
  responseText: string;
  intent?: string;
  entities?: Record<string, any>;
}

export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  // This function is now primarily for the web UI simulation.
  // Actual WhatsApp messages are handled by the webhook and processWhatsAppMessageFlow.
  console.log(`[Web UI Simulation] Handling message from ${senderType}: "${messageText}"`);
  try {
    const { intent, entities } = await recognizeIntent({ message: messageText, senderType });

    let responseText = "I'm not sure how to help with that. Can you try rephrasing?";

    switch (intent) {
      case 'book_appointment':
        responseText = `(Web UI Sim) Okay, I'll help you book an appointment.`;
        if (entities.reason) responseText += ` Reason: ${entities.reason}.`;
        if (entities.date) responseText += ` Date: ${entities.date}.`;
        if (entities.time) responseText += ` Time: ${entities.time}.`;
        responseText += `\nPlease confirm or provide missing info. For actual booking, use WhatsApp.`;
        break;
      case 'reschedule_appointment':
        responseText = `(Web UI Sim) Sure, I can help you reschedule.`;
        if (entities.patient_name && senderType === 'doctor') responseText += ` For patient: ${entities.patient_name}.`;
        if (entities.date) responseText += ` New date: ${entities.date}.`;
        if (entities.time) responseText += ` New time: ${entities.time}.`;
        responseText += `\nIs this correct? For actual rescheduling, use WhatsApp.`;
        break;
      case 'cancel_appointment':
         if (senderType === 'doctor' && entities.patient_name) {
            responseText = `(Web UI Sim) Appointment for patient ${entities.patient_name} would be cancelled. For actual cancellation, use WhatsApp.`;
        } else {
            responseText = "(Web UI Sim) Your appointment would be cancelled. For actual cancellation, use WhatsApp.";
        }
        break;
      case 'pause_bookings':
        responseText = `(Web UI Sim) Bookings would be paused.`;
        if (entities.start_date) responseText += ` From: ${entities.start_date}.`;
        if (entities.end_date) responseText += ` To: ${entities.end_date}.`;
        responseText += ` For actual pausing, doctor should use WhatsApp commands.`;
        break;
      case 'resume_bookings':
        responseText = "(Web UI Sim) Bookings would be resumed. For actual resumption, doctor should use WhatsApp commands.";
        break;
      case 'cancel_all_meetings_today':
        responseText = "(Web UI Sim) All meetings for today would be cancelled. For actual command, doctor should use WhatsApp.";
        break;
      case 'greeting':
        responseText = "Hello! How can I help you today? (Web UI Simulation)";
        break;
      case 'thank_you':
        responseText = "You're welcome! (Web UI Simulation)";
        break;
      case 'faq_opening_hours':
        responseText = "The clinic is open from 9 AM to 5 PM, Monday to Friday. (Web UI Simulation)";
        break;
      default:
         const {output} = await ai.generate({
            prompt: `The user sent: "${messageText}". Provide a helpful, concise, and generic response as a medical clinic AI assistant, as their specific intent was not recognized by the system. This is for a web UI test simulation.`,
            model: 'googleai/gemini-2.0-flash', // Ensure ai object is available
         });
        responseText = output?.text || "I'm sorry, I didn't quite understand that. Could you please rephrase? (Web UI Simulation)";
    }
    console.log(`[Web UI Simulation] Intent: ${intent}, Entities: ${JSON.stringify(entities)}, Response: "${responseText}"`);
    return { responseText, intent, entities };

  } catch (error) {
    console.error("Error in handleUserMessage (Web UI Simulation):", error);
    return { responseText: "Sorry, I encountered an error (Web UI Simulation). Please try again." };
  }
}

export async function getDailySummaryAction(): Promise<string> {
  console.log("[Web UI Action] Getting daily summary.");
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    const appointmentsFromSheet = await getAppointmentsFromSheet({ date: today, status: 'booked' });

    if (!appointmentsFromSheet || appointmentsFromSheet.length === 0) {
        return "No booked appointments scheduled for today.";
    }

    const formattedAppointments: GenerateDailySummaryInput['appointments'] = appointmentsFromSheet
      .map(app => ({
          patientName: app.patientName,
          time: app.appointmentTime,
          reason: app.reason,
    }));

    if (formattedAppointments.length === 0) { // Should be caught by the first check, but good to have.
        return "No booked appointments found for today after formatting.";
    }

    const { summary } = await generateDailySummary({ appointments: formattedAppointments });
    console.log("[Web UI Action] Generated daily summary text.");
    return summary;
  } catch (error) {
    console.error("Error in getDailySummaryAction (Web UI):", error);
    const errorMessage = (typeof error === 'object' && error !== null && 'message' in error) 
                         ? (error as Error).message 
                         : 'Unknown error';
    return `Sorry, I couldn't fetch the daily summary for the web UI due to an error: ${errorMessage}`;
  }
}
