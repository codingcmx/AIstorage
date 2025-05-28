
"use server";

import type { SenderType } from '@/types/chat';
import { recognizeIntent, type RecognizeIntentOutput } from '@/ai/flows/intent-recognition';
import { generateDailySummary, GenerateDailySummaryInput } from '@/ai/flows/daily-summary';
import { getAppointmentsFromSheet } from '@/services/google-sheets-service';
import { format } from 'date-fns';
import { ai } from '@/ai/genkit';

interface HandleUserMessageResult {
  responseText: string;
  intent?: string;
  entities?: Record<string, any>;
}

export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  console.log(`[Web UI Simulation] Handling message from ${senderType}: "${messageText}"`);
  let intentResult: RecognizeIntentOutput | undefined;
  let responseText: string;

  try {
    try {
      intentResult = await recognizeIntent({ message: messageText, senderType });
      console.log(`[Web UI Simulation] recognizeIntent successful. Intent: ${intentResult.intent}, Entities: ${JSON.stringify(intentResult.entities)}`);
    } catch (intentError: any) {
      console.error(
        "[Web UI Simulation] CRITICAL ERROR during recognizeIntent flow:",
        intentError.message || String(intentError),
        "Stack:", intentError.stack,
        "Detail:", intentError.detail || 'N/A',
        "Original Error Object:", JSON.stringify(intentError, Object.getOwnPropertyNames(intentError))
      );
      // Fall through to use generic AI response; the main catch block might also be hit depending on error severity.
      intentResult = { 
        intent: 'other', 
        entities: { error: "Intent recognition failed", originalError: intentError.message || String(intentError) },
        originalMessage: messageText // Ensure originalMessage is present
      }; 
    }

    const { intent, entities } = intentResult;
    responseText = "I'm not sure how to help with that. Can you try rephrasing? (Web UI Simulation)"; // Default

    switch (intent) {
      case 'book_appointment':
        responseText = `(Web UI Sim) Okay, I'll help you book an appointment.`;
        if (entities?.reason) responseText += ` Reason: ${entities.reason}.`;
        if (entities?.date) responseText += ` Date: ${entities.date}.`;
        if (entities?.time) responseText += ` Time: ${entities.time}.`;
        responseText += `\nPlease confirm or provide missing info. For actual booking, use WhatsApp.`;
        break;
      case 'reschedule_appointment':
        responseText = `(Web UI Sim) Sure, I can help you reschedule.`;
        if (entities?.patient_name && senderType === 'doctor') responseText += ` For patient: ${entities.patient_name}.`;
        if (entities?.date) responseText += ` New date: ${entities.date}.`;
        if (entities?.time) responseText += ` New time: ${entities.time}.`;
        responseText += `\nIs this correct? For actual rescheduling, use WhatsApp.`;
        break;
      case 'cancel_appointment':
         if (senderType === 'doctor' && entities?.patient_name) {
            responseText = `(Web UI Sim) Appointment for patient ${entities.patient_name} would be cancelled. For actual cancellation, use WhatsApp.`;
        } else {
            responseText = "(Web UI Sim) Your appointment would be cancelled. For actual cancellation, use WhatsApp.";
        }
        break;
      case 'pause_bookings':
        responseText = `(Web UI Sim) Bookings would be paused.`;
        if (entities?.start_date) responseText += ` From: ${entities.start_date}.`;
        if (entities?.end_date) responseText += ` To: ${entities.end_date}.`;
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
      case 'other':
      default: {
        try {
          const conversationalPrompt = `You are MediMate AI, a friendly and helpful AI assistant for Dr. [Doctor's Name]'s clinic, simulated in a web UI.
The user (a ${senderType}) sent: "${messageText}".
Your primary functions are to help with booking, rescheduling, or cancelling appointments. You can also answer simple questions about the clinic like opening hours.
If the user's message seems related to these functions, respond as if you are guiding them or asking for clarification for the simulation.
If the message is a general health query, provide a very brief, general, non-diagnostic piece of advice and strongly recommend booking an appointment for any medical concerns. Do NOT attempt to diagnose or give specific medical advice.
If the message is a simple greeting or social interaction, respond politely and conversationally.
If the message is completely unrelated or very unclear, politely state that you can primarily assist with appointments and clinic information in this simulation.
Keep your responses concise and helpful for this web UI simulation.`;

          console.log(`[Web UI Simulation] Attempting conversational AI response for message: "${messageText}" (Intent was '${intent}')`);
          const {output} = await ai.generate({
            prompt: conversationalPrompt,
            model: ai.getModel(), 
          });
          responseText = output?.text 
                         ? `(Web UI Sim) ${output.text}` 
                         : "I'm sorry, I didn't quite understand that. Could you please rephrase? (Web UI Simulation)";
          console.log(`[Web UI Simulation] Conversational AI response generated: "${responseText}"`);
        } catch (generateError: any) {
          console.error(
            "[Web UI Simulation] CRITICAL ERROR during ai.generate for fallback:",
            generateError.message || String(generateError),
            "Stack:", generateError.stack,
            "Detail:", generateError.detail || 'N/A',
            "Original Error Object:", JSON.stringify(generateError, Object.getOwnPropertyNames(generateError))
          );
          responseText = "I'm having trouble generating a response right now. (Web UI Simulation)";
          return { 
            responseText, 
            intent: intentResult?.intent, 
            entities: { ...intentResult?.entities, fallbackError: generateError.message || String(generateError) } 
          };
        }
      }
    }
    console.log(`[Web UI Simulation] Final response constructed. Response: "${responseText}"`);
    return { responseText, intent: intentResult?.intent, entities: intentResult?.entities };

  } catch (error: any) { 
    console.error(
      "[Web UI Simulation] UNHANDLED OUTER CATCH in handleUserMessage:",
      error.message || String(error),
      "Stack:", error.stack,
      "Detail:", error.detail || 'N/A',
      "Original Error Object:", JSON.stringify(error, Object.getOwnPropertyNames(error))
    );
    return { 
      responseText: "Sorry, a critical error occurred in the simulation. Please check the server logs.",
      intent: intentResult?.intent,
      entities: intentResult?.entities
    };
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

    if (formattedAppointments.length === 0) {
        return "No booked appointments found for today after formatting.";
    }

    const { summary } = await generateDailySummary({ appointments: formattedAppointments });
    console.log("[Web UI Action] Generated daily summary text.");
    return summary;
  } catch (error) {
    console.error("Error in getDailySummaryAction (Web UI):", error);
    const errorMessage = (typeof error === 'object' && error !== null && 'message' in error)
                         ? String((error as Error).message)
                         : 'Unknown error';
    return `Sorry, I couldn't fetch the daily summary for the web UI due to an error: ${errorMessage}`;
  }
}
