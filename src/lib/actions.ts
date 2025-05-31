
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
    const combined = `${dateStr}T${timeStr}`;
    const d = parseISO(combined);
    if (isValid(d)) return d;
  } catch { /* ignore */ }

  console.warn(`[Web UI Action] parseDateTimeWeb: Could not parse date "${dateStr}" and time "${timeStr}"`);
  return null;
}

// In-memory state for web UI simulation (does not persist or affect actual bookings)
let isBookingPausedWeb = false;
let pauseStartDateWeb: Date | null = null;
let pauseEndDateWeb: Date | null = null;
let webUiConversationContext: {
  lastIntent?: string;
  gatheredDate?: string;
  gatheredTime?: string;
} = {};

export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  console.log(`[Web UI Action] handleUserMessage: Received message "${messageText}" from ${senderType}. Context: ${JSON.stringify(webUiConversationContext)}`);
  let intentResult: RecognizeIntentOutput | undefined;
  let responseText: string;

  try {
    intentResult = await recognizeIntent({ message: messageText, senderType });
    let { intent, entities } = intentResult;
    console.log(`[Web UI Action] handleUserMessage: recognizeIntent result - Intent: ${intent}, Entities: ${JSON.stringify(entities)}`);

    // Handle follow-up context for booking
    if (webUiConversationContext.lastIntent === 'book_appointment') {
      if (!webUiConversationContext.gatheredDate && intent !== 'cancel_appointment') { // if date was expected
        if (entities?.date) {
          webUiConversationContext.gatheredDate = entities.date;
          intent = 'book_appointment'; // Keep intent as booking
          console.log(`[Web UI Action] Contextual update: Gathered date: ${entities.date}`);
        } else if (intent === 'other' && messageText.match(/\d{1,2}(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i) || messageText.match(/(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i) ) {
            // If AI failed to get date but user provided something date-like, stick to booking intent
            intent = 'book_appointment';
            // Let the main logic ask again, AI might pick it up next time with specific prompt.
        }
      } else if (webUiConversationContext.gatheredDate && !webUiConversationContext.gatheredTime && intent !== 'cancel_appointment') { // if time was expected
        if (entities?.time) {
          webUiConversationContext.gatheredTime = entities.time;
          intent = 'book_appointment'; // Keep intent as booking
          console.log(`[Web UI Action] Contextual update: Gathered time: ${entities.time}`);
        } else if (intent === 'other' && messageText.match(/\d{1,2}(:\d{2})?\s*(am|pm)?/i) ) {
            intent = 'book_appointment';
        }
      }
      // If an entity was just provided for an ongoing booking, ensure the intent remains 'book_appointment'
      if ((entities?.date || entities?.time || entities?.reason) && webUiConversationContext.lastIntent === 'book_appointment' && intent === 'other') {
        intent = 'book_appointment';
      }
    }


    switch (intent) {
      case 'book_appointment':
        webUiConversationContext.lastIntent = 'book_appointment';
        const dateFromEntities = entities?.date || webUiConversationContext.gatheredDate;
        const timeFromEntities = entities?.time || webUiConversationContext.gatheredTime;
        const reasonFromEntities = entities?.reason;

        if (isBookingPausedWeb && dateFromEntities) {
           try {
                const requestedDateObj = parse(dateFromEntities, 'yyyy-MM-dd', new Date());
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
            } catch(e) {
                console.warn(`[Web UI Action] Error parsing dateFromEntities '${dateFromEntities}' during pause check:`, e);
            }
        }

        if (!dateFromEntities) {
          responseText = "Sure, I can help you book an appointment! What day were you thinking of?";
          webUiConversationContext.gatheredDate = undefined; // Ensure it's waiting for date
          webUiConversationContext.gatheredTime = undefined;
        } else {
          webUiConversationContext.gatheredDate = dateFromEntities; // Store gathered date
          if (!timeFromEntities) {
            try {
              const parsedDate = parse(dateFromEntities, 'yyyy-MM-dd', new Date());
              responseText = `Okay, for ${isValid(parsedDate) ? format(parsedDate, 'MMMM do, yyyy') : dateFromEntities}. What time would you like to come in?`;
            } catch {
              responseText = `Okay, for ${dateFromEntities}. What time would you like to come in?`;
            }
            webUiConversationContext.gatheredTime = undefined; // Ensure it's waiting for time
          } else {
            webUiConversationContext.gatheredTime = timeFromEntities; // Store gathered time
            const appointmentDateTime = parseDateTimeWeb(dateFromEntities, timeFromEntities);
            if (!reasonFromEntities) {
              if (appointmentDateTime) {
                responseText = `Got it, ${format(appointmentDateTime, 'MMMM do, yyyy')} at ${format(appointmentDateTime, 'h:mm a')}. And what is the reason for your visit?`;
              } else {
                responseText = `Got it, for ${dateFromEntities} at ${timeFromEntities}. And what is the reason for your visit?`;
              }
            } else {
              if (appointmentDateTime) {
                responseText = `Great! Your appointment for "${reasonFromEntities}" is noted for ${format(appointmentDateTime, 'MMMM do, yyyy')} at ${format(appointmentDateTime, 'h:mm a')}. (This is a web UI test. No actual booking occurs.)`;
              } else {
                responseText = `Great! I have all the details: Date: ${dateFromEntities}, Time: ${timeFromEntities}, Reason: ${reasonFromEntities}. (This is a web UI test. No actual booking occurs.)`;
              }
              webUiConversationContext = {}; // Reset context after completion
            }
          }
        }
        break;

      case 'reschedule_appointment':
        responseText = `Okay, I can help with rescheduling.`;
        if (entities?.patient_name && senderType === 'doctor') responseText += ` For patient: ${entities.patient_name}.`;
        if (entities?.date) responseText += ` New date: ${entities.date}.`;
        if (entities?.time) responseText += ` New time: ${entities.time}.`;
        if (!entities?.date || !entities?.time) {
            responseText += ` Please provide the new date and time you'd like.`;
        } else {
            responseText += ` (This is a web UI test. No actual rescheduling occurs.)`;
        }
        webUiConversationContext = {}; // Reset context
        break;

      case 'cancel_appointment':
         if (senderType === 'doctor' && entities?.patient_name) {
            responseText = `Okay, I understand you want to cancel the appointment for ${entities.patient_name}.`;
        } else {
            responseText = "Okay, I understand you want to cancel your appointment.";
        }
        responseText += " (This is a web UI test. No actual cancellation occurs.)";
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
        // If it's an 'other' intent but we were in a booking flow, don't reset context yet. Let user try again.
        if (!webUiConversationContext.lastIntent) webUiConversationContext = {};
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

