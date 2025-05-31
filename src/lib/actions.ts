
"use server";

import type { SenderType } from '@/types/chat';
import { recognizeIntent, type RecognizeIntentOutput } from '@/ai/flows/intent-recognition';
import { generateDailySummary, GenerateDailySummaryInput } from '@/ai/flows/daily-summary';
import { getAppointmentsFromSheet } from '@/services/google-sheets-service';
import { format, parse, isValid, parseISO } from 'date-fns';
import { ai } from '@/ai/genkit';

interface HandleUserMessageResult {
  responseText: string;
  intent?: string;
  entities?: Record<string, any>;
}

// Helper to parse date and time from entities for Web UI
function parseDateTimeWeb(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr || !timeStr) {
    return null;
  }
  // Try YYYY-MM-DD HH:mm
  try {
    const d = parse(`${dateStr} ${timeStr}`, 'yyyy-MM-dd HH:mm', new Date());
    if (isValid(d)) return d;
  } catch { /* ignore */ }

  // Try YYYY-MM-DD h:mm a
  try {
    const d = parse(`${dateStr} ${timeStr}`, 'yyyy-MM-dd h:mm a', new Date());
    if (isValid(d)) return d;
  } catch { /* ignore */ }
  
  // Fallback for ISO-like date and simple time
  try {
    const combined = `${dateStr}T${timeStr}`; // Standard ISO format for date and time
    const d = parseISO(combined);
    if (isValid(d)) return d;
  } catch { /* ignore */ }
  
  // Try parsing just dateStr as ISO then applying time
   try {
    let baseDate = parseISO(dateStr);
    if (!isValid(baseDate)) { // If dateStr is not full ISO, try yyyy-MM-dd
        baseDate = parse(dateStr, 'yyyy-MM-dd', new Date());
    }
    if (isValid(baseDate)) {
        const timeParts = timeStr.match(/(\d{1,2})[:\.]?(\d{2})?(am|pm)?/i);
        if (timeParts) {
            let hours = parseInt(timeParts[1], 10);
            const minutes = timeParts[2] ? parseInt(timeParts[2], 10) : 0;
            const period = timeParts[3]?.toLowerCase();

            if (period === 'pm' && hours < 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0; // Midnight case

            const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), hours, minutes);
            if (isValid(d)) return d;
        }
    }
  } catch { /* ignore */ }


  console.warn(`[Web UI Action] parseDateTimeWeb: Could not parse date "${dateStr}" and time "${timeStr}"`);
  return null;
}

// In-memory state for web UI simulation (does not persist or affect actual bookings)
let isBookingPausedWeb = false;
let pauseStartDateWeb: Date | null = null;
let pauseEndDateWeb: Date | null = null;

// Updated conversation context
let webUiConversationContext: {
  lastIntent?: string;
  gatheredDate?: string; // For booking
  gatheredTime?: string; // For booking
  currentContextualDate?: string; // Date of appointment being discussed (e.g. for reschedule)
  gatheredRescheduleNewDate?: string;
  gatheredRescheduleNewTime?: string;
} = {};

export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  console.log(`[Web UI Action] handleUserMessage: Received message "${messageText}" from ${senderType}. Context: ${JSON.stringify(webUiConversationContext)}`);
  let intentResult: RecognizeIntentOutput | undefined;
  let responseText: string;

  try {
    // Pass contextualDate if available from previous turn (e.g. for rescheduling)
    intentResult = await recognizeIntent({ 
      message: messageText, 
      senderType,
      contextualDate: webUiConversationContext.currentContextualDate 
    });
    let { intent, entities } = intentResult;
    console.log(`[Web UI Action] handleUserMessage: recognizeIntent result - Intent: ${intent}, Entities: ${JSON.stringify(entities)}`);

    // Contextual updates for booking flow
    if (webUiConversationContext.lastIntent === 'book_appointment') {
      if (!webUiConversationContext.gatheredDate && entities?.date) {
        webUiConversationContext.gatheredDate = entities.date;
        if (intent !== 'book_appointment') intent = 'book_appointment'; // Maintain booking intent
      }
      if (webUiConversationContext.gatheredDate && !webUiConversationContext.gatheredTime && entities?.time) {
        webUiConversationContext.gatheredTime = entities.time;
        if (intent !== 'book_appointment') intent = 'book_appointment'; // Maintain booking intent
      }
      if ((entities?.date || entities?.time || entities?.reason) && intent === 'other') {
         intent = 'book_appointment'; // If AI got confused but provided relevant entities for booking
      }
    }
    
    // Contextual updates for rescheduling flow
    if (webUiConversationContext.lastIntent === 'reschedule_appointment') {
        if (entities?.date && !webUiConversationContext.gatheredRescheduleNewDate) {
            webUiConversationContext.gatheredRescheduleNewDate = entities.date;
            if(intent !== 'reschedule_appointment') intent = 'reschedule_appointment';
        }
        if (entities?.time && !webUiConversationContext.gatheredRescheduleNewTime) {
            webUiConversationContext.gatheredRescheduleNewTime = entities.time;
            if(intent !== 'reschedule_appointment') intent = 'reschedule_appointment';
        }
        // If date was provided by AI ("same day" became contextualDate) and only time is new from user
        if (entities?.date === webUiConversationContext.currentContextualDate && entities?.time && !webUiConversationContext.gatheredRescheduleNewTime) {
            webUiConversationContext.gatheredRescheduleNewDate = entities.date;
            webUiConversationContext.gatheredRescheduleNewTime = entities.time;
            if(intent !== 'reschedule_appointment') intent = 'reschedule_appointment';
        }
    }


    switch (intent) {
      case 'book_appointment':
        webUiConversationContext.lastIntent = 'book_appointment';
        const dateForBooking = entities?.date || webUiConversationContext.gatheredDate;
        const timeForBooking = entities?.time || webUiConversationContext.gatheredTime;
        const reasonForBooking = entities?.reason;

        if (isBookingPausedWeb && dateForBooking) {
           try {
                const requestedDateObj = parse(dateForBooking, 'yyyy-MM-dd', new Date());
                if (isValid(requestedDateObj)) {
                    const isPausedForRequestedDate =
                        (pauseStartDateWeb && pauseEndDateWeb && requestedDateObj >= pauseStartDateWeb && requestedDateObj <= pauseEndDateWeb) ||
                        (pauseStartDateWeb && !pauseEndDateWeb && format(requestedDateObj, 'yyyy-MM-dd') === format(pauseStartDateWeb, 'yyyy-MM-dd'));
                    if (isPausedForRequestedDate) {
                        responseText = `Bookings are currently paused for ${format(requestedDateObj, 'MMMM do')}. Please try a different date.`;
                        webUiConversationContext = {}; // Reset context
                        return { responseText, intent, entities };
                    }
                }
            } catch(e) { console.warn(`[Web UI Action] Error parsing dateForBooking '${dateForBooking}' during pause check:`, e); }
        }

        if (!dateForBooking) {
          responseText = "Sure, I can help you book an appointment! What day were you thinking of?";
          webUiConversationContext.gatheredDate = undefined; 
          webUiConversationContext.gatheredTime = undefined;
          webUiConversationContext.currentContextualDate = undefined;
        } else {
          webUiConversationContext.gatheredDate = dateForBooking;
          webUiConversationContext.currentContextualDate = dateForBooking; // Use this for any immediate follow-up context if needed
          if (!timeForBooking) {
            responseText = `Okay, for ${format(parse(dateForBooking, 'yyyy-MM-DD', new Date()), 'MMMM do, yyyy')}. What time would you like to come in?`;
            webUiConversationContext.gatheredTime = undefined;
          } else {
            webUiConversationContext.gatheredTime = timeForBooking;
            const appointmentDateTime = parseDateTimeWeb(dateForBooking, timeForBooking);
            if (!reasonForBooking) {
              responseText = `Got it, ${appointmentDateTime ? format(appointmentDateTime, 'MMMM do, yyyy \'at\' h:mm a') : `${dateForBooking} at ${timeForBooking}`}. And what is the reason for your visit?`;
            } else {
              responseText = `Great! Your appointment for "${reasonForBooking}" is noted for ${appointmentDateTime ? format(appointmentDateTime, 'MMMM do, yyyy \'at\' h:mm a') : `${dateForBooking} at ${timeForBooking}`}. (This is a web UI test. No actual booking occurs.)`;
              webUiConversationContext = {}; // Reset context
            }
          }
        }
        break;

      case 'reschedule_appointment': {
        webUiConversationContext.lastIntent = 'reschedule_appointment';
        const patientNameToReschedule = senderType === 'doctor' ? entities?.patient_name : undefined;
        
        // Date from entities could be the original appointment date OR the new desired date.
        // Time from entities is likely the new desired time.
        
        let originalApptDate = entities?.date && !webUiConversationContext.gatheredRescheduleNewDate && !webUiConversationContext.gatheredRescheduleNewTime ? entities.date : webUiConversationContext.currentContextualDate;
        let newRescheduleDate = webUiConversationContext.gatheredRescheduleNewDate || (entities?.date !== originalApptDate ? entities?.date : undefined);
        let newRescheduleTime = webUiConversationContext.gatheredRescheduleNewTime || entities?.time;

        if (originalApptDate && !webUiConversationContext.currentContextualDate) {
            webUiConversationContext.currentContextualDate = originalApptDate;
        }
        
        if (patientNameToReschedule) {
            responseText = `Okay, doctor. Rescheduling for ${patientNameToReschedule}.`;
            if (originalApptDate) responseText += ` Original appointment on ${originalApptDate}.`;
        } else {
            responseText = `Okay, I can help with rescheduling.`;
            if (originalApptDate) responseText += ` Your appointment is on ${originalApptDate}.`;
        }

        if (!newRescheduleDate && !newRescheduleTime) {
            responseText += ` What new date and time would you like?`;
            // Keep currentContextualDate if it's the original appointment date
        } else if (newRescheduleDate && !newRescheduleTime) {
            responseText += ` You've chosen ${newRescheduleDate}. What time would you like for the new appointment?`;
            webUiConversationContext.currentContextualDate = newRescheduleDate; // Context is now the new date
            webUiConversationContext.gatheredRescheduleNewDate = newRescheduleDate;
        } else if (!newRescheduleDate && newRescheduleTime) { // This case implies "same day" was likely used and AI picked up contextualDate
             if (webUiConversationContext.currentContextualDate) {
                 newRescheduleDate = webUiConversationContext.currentContextualDate; // Assume same day
                 webUiConversationContext.gatheredRescheduleNewDate = newRescheduleDate;
                 webUiConversationContext.gatheredRescheduleNewTime = newRescheduleTime;
                 const finalDateTime = parseDateTimeWeb(newRescheduleDate, newRescheduleTime);
                 responseText = `Okay, appointment rescheduled to ${finalDateTime ? format(finalDateTime, 'MMMM do, yyyy \'at\' h:mm a') : `${newRescheduleDate} at ${newRescheduleTime}`}. (This is a web UI test.)`;
                 webUiConversationContext = {}; // Reset context
             } else {
                 responseText += ` You've chosen ${newRescheduleTime}. What date would you like?`;
                 // Keep currentContextualDate (original) or clear if not relevant
             }
        } else { // Both new date and time are present
            const finalDateTime = parseDateTimeWeb(newRescheduleDate!, newRescheduleTime!);
            responseText = `Okay, appointment rescheduled to ${finalDateTime ? format(finalDateTime, 'MMMM do, yyyy \'at\' h:mm a') : `${newRescheduleDate} at ${newRescheduleTime}`}. (This is a web UI test.)`;
            if (patientNameToReschedule) responseText += ` For ${patientNameToReschedule}.`;
            webUiConversationContext = {}; // Reset context
        }
        break;
      }

      case 'cancel_appointment':
         webUiConversationContext.currentContextualDate = entities?.date || webUiConversationContext.currentContextualDate;
         if (senderType === 'doctor' && entities?.patient_name) {
            responseText = `Okay, I understand you want to cancel the appointment for ${entities.patient_name}`;
            if(webUiConversationContext.currentContextualDate) responseText += ` on ${webUiConversationContext.currentContextualDate}`;
        } else {
            responseText = "Okay, I understand you want to cancel your appointment";
            if(webUiConversationContext.currentContextualDate) responseText += ` on ${webUiConversationContext.currentContextualDate}`;
        }
        responseText += ". (This is a web UI test. No actual cancellation occurs.)";
        webUiConversationContext = {}; // Reset context
        break;

      case 'pause_bookings':
        if (senderType !== 'doctor') {
            responseText = "Sorry, only doctors can pause bookings.";
        } else {
            isBookingPausedWeb = true;
            pauseStartDateWeb = entities?.start_date ? parse(entities.start_date, 'yyyy-MM-dd', new Date()) : new Date();
            pauseEndDateWeb = entities?.end_date ? parse(entities.end_date, 'yyyy-MM-dd', new Date()) : null;
            responseText = `Okay, doctor. Bookings will be treated as paused in this UI.`;
            if (entities?.start_date) responseText += ` From: ${entities.start_date}.`;
            if (entities?.end_date) responseText += ` To: ${entities.end_date}.`;
        }
        webUiConversationContext = {}; // Reset context
        break;

      case 'resume_bookings':
        if (senderType !== 'doctor') {
            responseText = "Sorry, only doctors can resume bookings.";
        } else {
            isBookingPausedWeb = false;
            pauseStartDateWeb = null;
            pauseEndDateWeb = null;
            responseText = "Okay, doctor. Bookings will be treated as resumed in this UI.";
        }
        webUiConversationContext = {}; // Reset context
        break;

      case 'cancel_all_meetings_today':
         if (senderType !== 'doctor') {
            responseText = "Sorry, only doctors can perform this action.";
        } else {
            responseText = "Okay, doctor. All meetings for today would be cancelled. (This is a web UI test.)";
        }
        webUiConversationContext = {}; // Reset context
        break;

      case 'greeting':
        responseText = "Hello! I'm MediMate AI. How can I help you with your appointments today?";
        webUiConversationContext = {}; // Reset context
        break;
      case 'thank_you':
        responseText = "You're very welcome! Is there anything else I can assist you with?";
        webUiConversationContext = {}; // Reset context
        break;
      case 'faq_opening_hours':
        responseText = "The clinic is open from 9 AM to 5 PM, Monday to Friday. We are closed on weekends and public holidays.";
        webUiConversationContext = {}; // Reset context
        break;
      case 'other':
      default: {
        const conversationalPrompt = `You are MediMate AI, a friendly and helpful WhatsApp assistant for Dr. [Doctor's Name]'s clinic, currently being tested in a web UI.
The user (a ${senderType}) sent: "${messageText}".
Your primary functions are to help with booking, rescheduling, or cancelling appointments. You can also answer simple questions about the clinic like opening hours.
If the user's message seems related to these functions but is incomplete, guide them or ask for clarification.
If the message is a general health query, provide a very brief, general, non-diagnostic piece of advice and strongly recommend booking an appointment for any medical concerns. Do NOT attempt to diagnose or give specific medical advice.
If the message is a simple greeting or social interaction, respond politely and conversationally.
If the message is completely unrelated or very unclear, politely state that you can primarily assist with appointments and clinic information in this test environment.
Keep your responses concise and helpful. Be friendly and empathetic. If you don't understand, ask for clarification.`;
        try {
          console.log(`[Web UI Action] Fallback to conversational AI prompt for message: "${messageText}" (Intent: ${intent})`);
          const {output} = await ai.generate({
            prompt: conversationalPrompt,
            model: 'googleai/gemini-2.0-flash',
          });
          responseText = output?.text || "I'm sorry, I didn't quite understand that. I can help with booking, rescheduling, or cancelling appointments, or provide information about the clinic. How can I assist you?";
        } catch (genError: any) {
           const genErrorMessage = genError.message || String(genError);
           console.error(`[Web UI Action] CRITICAL ERROR during ai.generate for fallback. Message: "${messageText}". Error: ${genErrorMessage}`, genError.stack);
          responseText = "Sorry, I'm having trouble generating a response right now. Please check server logs.";
          return {
            responseText,
            intent: intentResult?.intent || "other_error",
            entities: { ...(intentResult?.entities || {}), fallbackError: genErrorMessage, detail: genError.detail }
          };
        }
        // If it's an 'other' intent but we were in a booking/reschedule flow, don't fully reset context yet.
        // Only fully reset if not in a known multi-turn flow.
        if (!webUiConversationContext.lastIntent) {
            webUiConversationContext = {};
        } else if (webUiConversationContext.lastIntent !== 'book_appointment' && webUiConversationContext.lastIntent !== 'reschedule_appointment') {
            webUiConversationContext = {};
        }
      }
    }
    return { responseText, intent: intentResult?.intent, entities: intentResult?.entities };

  } catch (error: any) {
    const errorMessage = error.message || String(error);
    console.error(`[Web UI Action] CRITICAL ERROR in handleUserMessage. Message: "${messageText}". Error: ${errorMessage}`, error.stack);
    responseText = "Sorry, I encountered an error processing your message. Please try again.";
    webUiConversationContext = {}; // Reset context on critical error
    return {
      responseText,
      intent: intentResult?.intent || "error",
      entities: { ...(intentResult?.entities || {}), errorMessage, detail: error.detail }
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
  } catch (error: any) {
    const errorMessage = (typeof error === 'object' && error !== null && 'message' in error)
                         ? String((error as Error).message)
                         : 'Unknown error';
    console.error(`[Web UI Action] Error in getDailySummaryAction: ${errorMessage}`, error.stack);
    return `Sorry, I couldn't fetch the daily summary due to an error: ${errorMessage}`;
  }
}
