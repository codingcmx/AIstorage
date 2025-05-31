
"use server";

import type { SenderType } from '@/types/chat';
import { recognizeIntent, type RecognizeIntentOutput } from '@/ai/flows/intent-recognition';
import { generateDailySummary, GenerateDailySummaryInput } from '@/ai/flows/daily-summary';
import { getAppointmentsFromSheet } from '@/services/google-sheets-service';
import { format, parse, isValid, parseISO, isFuture, setHours, setMinutes, setSeconds, setMilliseconds, getHours, startOfDay, endOfDay, isWithinInterval, isSameDay } from 'date-fns';
import { ai } from '@/ai/genkit';

interface HandleUserMessageResult {
  responseText: string;
  intent?: string;
  entities?: Record<string, any>;
}

// Define Doctor's Working Hours (for Web UI simulation)
const DOCTOR_WORK_START_HOUR = 9; // 9 AM
const DOCTOR_WORK_END_HOUR = 17; // 5 PM (exclusive, so up to 4:59 PM)

// Helper to parse date and time from entities for Web UI
function parseDateTimeWeb(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr || !timeStr) {
    console.warn(`[Web UI Action] parseDateTimeWeb: Missing dateStr ('${dateStr}') or timeStr ('${timeStr}')`);
    return null;
  }
  console.log(`[Web UI Action] parseDateTimeWeb: Attempting to parse date: "${dateStr}", time: "${timeStr}"`);

  const dateTimeFormats = [
    'yyyy-MM-dd HH:mm',
    'yyyy-MM-dd h:mm a',
    'yyyy-MM-dd hh:mma',
    'yyyy-MM-dd ha',
  ];

  for (const fmt of dateTimeFormats) {
    try {
      const d = parse(`${dateStr} ${timeStr}`, fmt, new Date());
      if (isValid(d)) {
        console.log(`[Web UI Action] parseDateTimeWeb: Parsed with format "${fmt}":`, d);
        return d;
      }
    } catch { /* ignore and try next format */ }
  }

  try {
    let baseDate = parseISO(dateStr);
    if (!isValid(baseDate)) {
      baseDate = parse(dateStr, 'yyyy-MM-dd', new Date());
    }

    if (!isValid(baseDate)) {
      console.warn(`[Web UI Action] parseDateTimeWeb: Fallback - Unparseable date string: "${dateStr}" after ISO and yyyy-MM-dd attempts.`);
      return null;
    }

    const timeMatch = timeStr.match(/(\d{1,2})[:\.]?(\d{2})?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const period = timeMatch[3]?.toLowerCase();

      if (period === 'pm' && hour < 12) hour += 12;
      if (period === 'am' && hour === 12) hour = 0;

      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        let resultDate = setHours(baseDate, hour);
        resultDate = setMinutes(resultDate, minute);
        resultDate = setSeconds(resultDate, 0);
        resultDate = setMilliseconds(resultDate, 0);

        if (isValid(resultDate)) {
          console.log(`[Web UI Action] parseDateTimeWeb: Fallback - Parsed date with regex time on baseDate ${format(baseDate, 'yyyy-MM-dd')}:`, resultDate);
          return resultDate;
        } else {
            console.warn(`[Web UI Action] parseDateTimeWeb: Fallback - Resulting date from setHours/Minutes is invalid. Base: ${baseDate}, H:${hour}, M:${minute}`);
        }
      } else {
         console.warn(`[Web UI Action] parseDateTimeWeb: Fallback - Invalid hour/minute from regex: hour=${hour}, minute=${minute} for timeStr: "${timeStr}"`);
      }
    } else {
      console.warn(`[Web UI Action] parseDateTimeWeb: Fallback - Time string "${timeStr}" did not match regex.`);
    }
  } catch (e: any) {
    console.error(`[Web UI Action] parseDateTimeWeb: Fallback - Error in date/time parsing for dateStr: "${dateStr}", timeStr: "${timeStr}":`, e.message || String(e));
  }

  console.warn(`[Web UI Action] parseDateTimeWeb: Failed to parse date "${dateStr}" and time "${timeStr}" using all methods.`);
  return null;
}

let webUiConversationContext: {
  lastIntent?: string;
  gatheredDate?: string;
  gatheredTime?: string;
  currentContextualDate?: string;
  gatheredReason?: string;
  gatheredRescheduleNewDate?: string;
  gatheredRescheduleNewTime?: string;
} = {};

// State for simulating booking pause in Web UI
let isBookingPausedWeb = false;
let pauseStartDateWeb: Date | null = null;
let pauseEndDateWeb: Date | null = null;


export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  console.log(`[Web UI Action] handleUserMessage: Received message "${messageText}" from ${senderType}. Context BEFORE AI: ${JSON.stringify(webUiConversationContext)}`);
  let intentResult: RecognizeIntentOutput | undefined;
  let responseText: string;

  try {
    intentResult = await recognizeIntent({
      message: messageText,
      senderType,
      contextualDate: webUiConversationContext.currentContextualDate
    });
    let { intent, entities } = intentResult;
    console.log(`[Web UI Action] handleUserMessage: recognizeIntent result - Intent: ${intent}, Entities: ${JSON.stringify(entities)}`);

    if (webUiConversationContext.lastIntent === 'book_appointment') {
      if (!webUiConversationContext.gatheredDate && entities?.date) {
        webUiConversationContext.gatheredDate = entities.date;
        if (intent !== 'book_appointment') intent = 'book_appointment';
      }
      if (webUiConversationContext.gatheredDate && !webUiConversationContext.gatheredTime && entities?.time) {
        webUiConversationContext.gatheredTime = entities.time;
        if (intent !== 'book_appointment') intent = 'book_appointment';
      }
      if (webUiConversationContext.gatheredDate && webUiConversationContext.gatheredTime && !webUiConversationContext.gatheredReason && entities?.reason){
        webUiConversationContext.gatheredReason = entities.reason;
        if (intent !== 'book_appointment') intent = 'book_appointment';
      }
      if ((entities?.date || entities?.time || entities?.reason) && intent === 'other' && webUiConversationContext.lastIntent === 'book_appointment') {
         intent = 'book_appointment';
      }
    } else if (webUiConversationContext.lastIntent === 'reschedule_appointment') {
        if (entities?.date && !webUiConversationContext.gatheredRescheduleNewDate) {
            webUiConversationContext.gatheredRescheduleNewDate = entities.date;
            if(intent !== 'reschedule_appointment') intent = 'reschedule_appointment';
        }
        if (entities?.time && !webUiConversationContext.gatheredRescheduleNewTime) {
            webUiConversationContext.gatheredRescheduleNewTime = entities.time;
            if(intent !== 'reschedule_appointment') intent = 'reschedule_appointment';
        }
        if ((entities?.date || entities?.time) && intent === 'other' && webUiConversationContext.lastIntent === 'reschedule_appointment') {
             intent = 'reschedule_appointment';
        }
    }


    switch (intent) {
      case 'book_appointment':
        const dateForBooking = webUiConversationContext.gatheredDate || entities?.date;
        const timeForBooking = webUiConversationContext.gatheredTime || entities?.time;
        const reasonForBooking = webUiConversationContext.gatheredReason || entities?.reason;
        webUiConversationContext.lastIntent = 'book_appointment';

        if (isBookingPausedWeb && dateForBooking) {
           try {
                const requestedDateObj = parse(dateForBooking, 'yyyy-MM-dd', new Date());
                if (isValid(requestedDateObj)) {
                    const isPausedForRequestedDate =
                        (pauseStartDateWeb && pauseEndDateWeb && isWithinInterval(requestedDateObj, { start: startOfDay(pauseStartDateWeb), end: endOfDay(pauseEndDateWeb) })) ||
                        (pauseStartDateWeb && !pauseEndDateWeb && isSameDay(requestedDateObj, pauseStartDateWeb));

                    if (isPausedForRequestedDate) {
                        responseText = `I'm sorry, bookings are currently paused for ${format(requestedDateObj, 'MMMM do')}${pauseEndDateWeb && !isSameDay(pauseStartDateWeb!, pauseEndDateWeb) ? ` (paused until ${format(pauseEndDateWeb, 'MMMM do')})` : ''}. Please try a different date.`;
                        webUiConversationContext = {};
                        return { responseText, intent, entities };
                    }
                }
            } catch(e) { console.warn(`[Web UI Action] Error parsing dateForBooking '${dateForBooking}' during pause check:`, e); }
        }

        if (!dateForBooking) {
          responseText = "Sure, I can help you book an appointment! What day were you thinking of?";
          webUiConversationContext.gatheredDate = undefined;
          webUiConversationContext.gatheredTime = undefined;
          webUiConversationContext.gatheredReason = undefined;
          webUiConversationContext.currentContextualDate = undefined;
        } else {
          webUiConversationContext.gatheredDate = dateForBooking;
          webUiConversationContext.currentContextualDate = dateForBooking; // Set for follow-ups like reason
          if (!timeForBooking) {
            const parsedDisplayDate = parse(dateForBooking, 'yyyy-MM-dd', new Date());
            const displayDate = isValid(parsedDisplayDate) ? format(parsedDisplayDate, 'MMMM do, yyyy') : dateForBooking;
            responseText = `Okay, for ${displayDate}. What time would you like to come in?`;
            webUiConversationContext.gatheredTime = undefined;
            webUiConversationContext.gatheredReason = undefined;
          } else {
            webUiConversationContext.gatheredTime = timeForBooking;
            const appointmentDateTime = parseDateTimeWeb(dateForBooking, timeForBooking);

            if (!appointmentDateTime || !isFuture(appointmentDateTime)) {
                responseText = `The appointment time ${dateForBooking} at ${timeForBooking} is either invalid or in the past. Please provide a valid future date and time.`;
                webUiConversationContext.gatheredDate = dateForBooking; // Keep date, clear time
                webUiConversationContext.gatheredTime = undefined;
                webUiConversationContext.gatheredReason = undefined; // Clear reason as time was invalid
                break;
            }

            const requestedHour = getHours(appointmentDateTime);
            if (requestedHour < DOCTOR_WORK_START_HOUR || requestedHour >= DOCTOR_WORK_END_HOUR) {
                 responseText = `I'm sorry, the clinic is open from ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} to ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR), 'h a')}. The time you requested (${format(appointmentDateTime, 'h:mm a')}) is outside these hours. Would you like to choose a different time on ${format(appointmentDateTime, 'MMMM do')} or another day?`;
                 webUiConversationContext.gatheredTime = undefined; // Ask for time again
                 break;
            }


            if (!reasonForBooking) {
              responseText = `Got it, ${format(appointmentDateTime, 'MMMM do, yyyy \'at\' h:mm a')}. And what is the reason for your visit?`;
              webUiConversationContext.gatheredReason = undefined;
            } else {
              webUiConversationContext.gatheredReason = reasonForBooking;
              responseText = `Great! Your appointment for "${reasonForBooking}" is noted for ${format(appointmentDateTime, 'MMMM do, yyyy \'at\' h:mm a')}. (This is a web UI test. No actual booking occurs.)`;
              webUiConversationContext = {};
            }
          }
        }
        break;

      case 'reschedule_appointment': {
        webUiConversationContext.lastIntent = 'reschedule_appointment';
        const patientNameToReschedule = senderType === 'doctor' ? entities?.patient_name : undefined;

        if (!webUiConversationContext.currentContextualDate && entities?.date && !entities.time) {
            const parsedContextualDate = parse(entities.date, 'yyyy-MM-dd', new Date());
            if(isValid(parsedContextualDate)) {
                webUiConversationContext.currentContextualDate = entities.date;
                 console.log(`[Web UI Action Reschedule] Initial original appointment date set to: ${entities.date} from AI entity.`);
            } else {
                 console.warn(`[Web UI Action Reschedule] AI provided an invalid date ('${entities.date}') as a potential contextual date.`);
            }
        }
        const originalApptDateForDisplay = webUiConversationContext.currentContextualDate;

        let newRescheduleDate = webUiConversationContext.gatheredRescheduleNewDate || (entities?.date !== originalApptDateForDisplay ? entities?.date : (entities?.date === originalApptDateForDisplay && entities?.time ? entities.date : undefined));
        let newRescheduleTime = webUiConversationContext.gatheredRescheduleNewTime || entities?.time;

        if (patientNameToReschedule) {
            responseText = `Okay, doctor. Rescheduling for ${patientNameToReschedule}.`;
            if (originalApptDateForDisplay) {
                 const parsedDisplayOrigDate = parse(originalApptDateForDisplay, 'yyyy-MM-dd', new Date());
                 responseText += ` Their appointment on ${isValid(parsedDisplayOrigDate) ? format(parsedDisplayOrigDate, 'MMMM do, yyyy') : originalApptDateForDisplay}.`;
            } else {
                 responseText += " Which appointment are you referring to? (Please provide the original date or patient details if not already mentioned).";
                 break;
            }
        } else {
            responseText = `Okay, I can help with rescheduling.`;
            if (originalApptDateForDisplay) {
                const parsedDisplayOrigDate = parse(originalApptDateForDisplay, 'yyyy-MM-dd', new Date());
                responseText += ` Your appointment is on ${isValid(parsedDisplayOrigDate) ? format(parsedDisplayOrigDate, 'MMMM do, yyyy') : originalApptDateForDisplay}.`;
            } else {
                responseText += " Which appointment would you like to reschedule? Please provide its date.";
                webUiConversationContext.currentContextualDate = undefined;
                break;
            }
        }

        if (originalApptDateForDisplay) {
            if (!newRescheduleDate && !newRescheduleTime) {
                responseText += ` What new date and time would you like for the appointment?`;
            } else if (newRescheduleDate && !newRescheduleTime) {
                const parsedNewRescheduleDate = parse(newRescheduleDate, 'yyyy-MM-dd', new Date());
                responseText += ` You've chosen ${isValid(parsedNewRescheduleDate) ? format(parsedNewRescheduleDate, 'MMMM do, yyyy') : newRescheduleDate} as the new date. What time would you like?`;
                webUiConversationContext.gatheredRescheduleNewDate = newRescheduleDate;
                webUiConversationContext.currentContextualDate = newRescheduleDate; // Update context to new date for follow-up
            } else if (!newRescheduleDate && newRescheduleTime) {
                 newRescheduleDate = originalApptDateForDisplay;
                 const finalDateTime = parseDateTimeWeb(newRescheduleDate, newRescheduleTime);
                 if (!finalDateTime || !isFuture(finalDateTime)) {
                    const parsedOriginalDate = parse(newRescheduleDate, 'yyyy-MM-dd', new Date());
                    responseText = `The new time ${newRescheduleTime} on ${isValid(parsedOriginalDate) ? format(parsedOriginalDate, 'MMMM do, yyyy') : newRescheduleDate} is either invalid or in the past. Please provide a valid future time.`;
                    webUiConversationContext.gatheredRescheduleNewTime = undefined;
                 } else {
                    const requestedHour = getHours(finalDateTime);
                    if (requestedHour < DOCTOR_WORK_START_HOUR || requestedHour >= DOCTOR_WORK_END_HOUR) {
                         responseText = `I'm sorry, the clinic is open from ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} to ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR), 'h a')}. The new time you requested (${format(finalDateTime, 'h:mm a')}) is outside these hours. Please choose a different time.`;
                         webUiConversationContext.gatheredRescheduleNewTime = undefined;
                    } else {
                        responseText = `Okay, appointment rescheduled to ${format(finalDateTime, 'MMMM do, yyyy \'at\' h:mm a')}. (This is a web UI test.)`;
                        if (patientNameToReschedule) responseText += ` For ${patientNameToReschedule}.`;
                        webUiConversationContext = {};
                    }
                 }
            } else {
                const finalDateTime = parseDateTimeWeb(newRescheduleDate!, newRescheduleTime!);
                 if (!finalDateTime || !isFuture(finalDateTime)) {
                    responseText = `The new appointment time ${newRescheduleDate} at ${newRescheduleTime} is either invalid or in the past. Please provide a valid future date and time.`;
                    webUiConversationContext.gatheredRescheduleNewDate = newRescheduleDate; // Keep new date if provided
                    webUiConversationContext.gatheredRescheduleNewTime = undefined;
                 } else {
                    const requestedHour = getHours(finalDateTime);
                     if (requestedHour < DOCTOR_WORK_START_HOUR || requestedHour >= DOCTOR_WORK_END_HOUR) {
                         responseText = `I'm sorry, the clinic is open from ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} to ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR), 'h a')}. The new time you requested (${format(finalDateTime, 'h:mm a')}) is outside these hours. Please choose a different time or another day.`;
                         webUiConversationContext.gatheredRescheduleNewDate = newRescheduleDate;
                         webUiConversationContext.gatheredRescheduleNewTime = undefined;
                     } else {
                        responseText = `Okay, appointment rescheduled to ${format(finalDateTime, 'MMMM do, yyyy \'at\' h:mm a')}. (This is a web UI test.)`;
                        if (patientNameToReschedule) responseText += ` For ${patientNameToReschedule}.`;
                        webUiConversationContext = {};
                     }
                 }
            }
        }
        break;
      }

      case 'cancel_appointment':
         const dateToCancel = entities?.date || webUiConversationContext.currentContextualDate;
         const parsedDateToCancel = dateToCancel ? parse(dateToCancel, 'yyyy-MM-dd', new Date()) : null;
         const displayDateToCancel = parsedDateToCancel && isValid(parsedDateToCancel) ? format(parsedDateToCancel, 'MMMM do, yyyy') : dateToCancel;

         if (senderType === 'doctor' && entities?.patient_name) {
            responseText = `Okay, I understand you want to cancel the appointment for ${entities.patient_name}`;
            if(displayDateToCancel) responseText += ` on ${displayDateToCancel}`;
        } else {
            responseText = "Okay, I understand you want to cancel your appointment";
            if(displayDateToCancel) responseText += ` scheduled for ${displayDateToCancel}`;
            else responseText += ". Which appointment are you referring to?";
        }
        responseText += ". (This is a web UI test. No actual cancellation occurs.)";
        webUiConversationContext = {};
        break;

      case 'pause_bookings':
        if (senderType !== 'doctor') {
            responseText = "Sorry, only doctors can pause bookings.";
        } else {
            isBookingPausedWeb = true;
            const startDateEntity = entities?.start_date;
            const endDateEntity = entities?.end_date;

            if (startDateEntity) {
                try {
                    pauseStartDateWeb = parse(startDateEntity, 'yyyy-MM-dd', new Date());
                    if (!isValid(pauseStartDateWeb)) pauseStartDateWeb = new Date(); // Default to today if parsing fails
                } catch { pauseStartDateWeb = new Date(); }
            } else {
                pauseStartDateWeb = new Date(); // Pause from today by default if no start_date
            }

            if (endDateEntity) {
                 try {
                    pauseEndDateWeb = parse(endDateEntity, 'yyyy-MM-dd', new Date());
                    if (!isValid(pauseEndDateWeb)) pauseEndDateWeb = null;
                } catch { pauseEndDateWeb = null; }
            } else {
                pauseEndDateWeb = null; // No end date means indefinite (or just for start_date if no end_date given)
            }
            
            if (pauseStartDateWeb && pauseEndDateWeb && pauseStartDateWeb > pauseEndDateWeb) {
                 responseText = "Doctor, the start date for pausing bookings cannot be after the end date. Please try again.";
                 isBookingPausedWeb = false; // Revert pause
                 pauseStartDateWeb = null;
                 pauseEndDateWeb = null;
            } else {
                responseText = `Okay, doctor. Bookings are now paused in this UI`;
                if (pauseStartDateWeb) responseText += ` from ${format(pauseStartDateWeb, 'MMMM do, yyyy')}`;
                if (pauseEndDateWeb) responseText += ` to ${format(pauseEndDateWeb, 'MMMM do, yyyy')}`;
                else if (pauseStartDateWeb) responseText += ` (for this day only unless an end date is specified later).`;
                else responseText += ` indefinitely.`;
            }
        }
        webUiConversationContext = {}; // Clear context after this command
        break;

      case 'resume_bookings':
        if (senderType !== 'doctor') {
            responseText = "Sorry, only doctors can resume bookings.";
        } else {
            isBookingPausedWeb = false;
            pauseStartDateWeb = null;
            pauseEndDateWeb = null;
            responseText = "Okay, doctor. Bookings are now resumed in this UI.";
        }
        webUiConversationContext = {};
        break;

      case 'cancel_all_meetings_today':
         if (senderType !== 'doctor') {
            responseText = "Sorry, only doctors can perform this action.";
        } else {
            responseText = "Okay, doctor. All meetings for today would be cancelled. (This is a web UI test.)";
        }
        webUiConversationContext = {};
        break;

      case 'greeting':
        responseText = "Hello! I'm MediMate AI. How can I help you with your appointments today?";
        // Don't clear context on greeting if a booking was in progress
        if (webUiConversationContext.lastIntent !== 'book_appointment' && webUiConversationContext.lastIntent !== 'reschedule_appointment') {
            webUiConversationContext = {};
        }
        break;
      case 'thank_you':
        responseText = "You're very welcome! Is there anything else I can assist you with?";
        if (webUiConversationContext.lastIntent !== 'book_appointment' && webUiConversationContext.lastIntent !== 'reschedule_appointment') {
            webUiConversationContext = {};
        }
        break;
      case 'faq_opening_hours':
        responseText = `The clinic is open from ${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} to ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR), 'h a')}, Monday to Friday. We are closed on weekends and public holidays.`;
        if (webUiConversationContext.lastIntent !== 'book_appointment' && webUiConversationContext.lastIntent !== 'reschedule_appointment') {
            webUiConversationContext = {};
        }
        break;
      case 'other':
      default: {
        const conversationalPrompt = `You are MediMate AI, a friendly and helpful WhatsApp assistant for Dr. [Doctor's Name]'s clinic, currently being tested in a web UI.
The user (a ${senderType}) sent: "${messageText}".
Your primary functions are to help with booking, rescheduling, or cancelling appointments. You can also answer simple questions about the clinic like opening hours (${format(setHours(new Date(), DOCTOR_WORK_START_HOUR), 'h a')} to ${format(setHours(new Date(), DOCTOR_WORK_END_HOUR), 'h a')}, Mon-Fri).
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
        if (!webUiConversationContext.lastIntent || (webUiConversationContext.lastIntent !== 'book_appointment' && webUiConversationContext.lastIntent !== 'reschedule_appointment')) {
            webUiConversationContext = {};
        }
      }
    }
    console.log(`[Web UI Action] handleUserMessage: Context AFTER processing: ${JSON.stringify(webUiConversationContext)}`);
    return { responseText, intent: intentResult?.intent, entities: intentResult?.entities };

  } catch (error: any) {
    const errorMessage = error.message || String(error);
    console.error(`[Web UI Action] CRITICAL ERROR in handleUserMessage. Message: "${messageText}". Error: ${errorMessage}`, error.stack);
    responseText = "Sorry, I encountered an error processing your message. Please try again.";
    webUiConversationContext = {};
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
    // In a real scenario, this would fetch from where actual bookings are stored.
    // For the web UI, this still uses Google Sheets as a placeholder.
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
