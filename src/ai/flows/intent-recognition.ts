'use server';

/**
 * @fileOverview Recognizes the intent of a message from a patient or doctor.
 *
 * - recognizeIntent - A function that recognizes the intent of a message.
 * - RecognizeIntentInput - The input type for the recognizeIntent function (imported from schemas).
 * - RecognizeIntentOutput - The return type for the recognizeIntent function (imported from schemas).
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
// Import schemas and types from the new schemas.ts file
import {
  RecognizeIntentInputSchema,
  type RecognizeIntentInput,
  RecognizeIntentPromptOutputSchema, // Schema for the AI prompt's output
  type RecognizeIntentOutput // Type for the exported function's output
} from '../schemas'; // Adjusted path

// Re-export types for external use if needed by other server components/actions
export type { RecognizeIntentInput, RecognizeIntentOutput };

export async function recognizeIntent(input: RecognizeIntentInput): Promise<RecognizeIntentOutput> {
  console.log('[Intent Recognition Flow] Attempting to recognize intent for:', JSON.stringify(input));
  try {
    const result = await recognizeIntentFlow({
      ...input, // message, senderType, contextualDate (if provided)
      currentDate: new Date().toISOString().split('T')[0], // Pass current date for relative date resolution
    });
    // Ensure entities is always an object, even if undefined from the flow
    const entities = result.entities || {};
    const output = { ...result, entities, originalMessage: input.message };
    console.log('[Intent Recognition Flow] Final output (with originalMessage):', JSON.stringify(output));
    return output;
  } catch (error: any) {
    console.error('[Intent Recognition Flow] CRITICAL ERROR in recognizeIntent function:', error.message || String(error), error.stack);
    console.error('[Intent Recognition Flow] Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    throw error;
  }
}

// Add currentDate to the input schema for the prompt
const recognizeIntentPromptInputSchema = RecognizeIntentInputSchema.extend({
  currentDate: z.string().describe("The current date in YYYY-MM-DD format, for resolving relative dates.")
});


const prompt = ai.definePrompt({
  name: 'recognizeIntentPrompt',
  input: {schema: recognizeIntentPromptInputSchema},
  output: {schema: RecognizeIntentPromptOutputSchema},
  prompt: `You are an AI assistant for a doctor's clinic. Your primary task is to understand messages related to appointment management (book, reschedule, cancel) and extract relevant information.
You should understand messages in English and Hinglish (a mix of Hindi and English).
Today's date is {{currentDate}}.
{{#if contextualDate}}The current appointment being discussed (e.g., for rescheduling) is on {{contextualDate}}. If the user says "same day" or "that day" when providing a new time or detail, assume they are referring to this {{contextualDate}}.{{/if}}
Use {{currentDate}} to resolve other relative dates like "tomorrow", "next Monday", "kal", "parso".
The message is from a {{senderType}}.

Your goal is to extract:
1. Intent: 'book_appointment', 'reschedule_appointment', 'cancel_appointment', 'pause_bookings', 'resume_bookings', 'cancel_all_meetings_today', 'greeting', 'thank_you', 'faq_opening_hours', or 'other'.
2. Date: In YYYY-MM-DD format. For rescheduling, this is the NEW desired date. If "same day" is used in context of {{contextualDate}}, then the date is {{contextualDate}}.
3. Time: In HH:mm (24-hour) format. If AM/PM is used, convert it. If "afternoon" is mentioned without a specific time, assume 14:00. If "morning", assume 10:00. If "evening", assume 18:00. "Subah" can mean morning, "dopahar" afternoon, "shaam" evening. For rescheduling, this is the NEW desired time.
4. Reason: For 'book_appointment' intent, extract the reason for the visit if provided.
5. Patient Name: For doctor commands like '/cancel [patient_name]' or '/reschedule [patient_name]', extract the patient_name.
6. Start Date: For '/pause bookings from [start_date]', extract start_date.
7. End Date: For '/pause bookings from [start_date] to [end_date]', extract end_date.

Output should be a JSON object.

Examples:

Patient Intents & Entity Extraction (English & Hinglish):
- Message: "I want an appointment next Monday at 2pm"
  (Assuming {{currentDate}} makes "next Monday" resolve to a specific YYYY-MM-DD)
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (for next Monday)", "time": "14:00" } }

- Message: "Mujhe kal 2 baje ka appointment chahiye." (I want an appointment for tomorrow at 2 o'clock.)
  (Assuming {{currentDate}} makes "kal" (tomorrow) resolve to a specific YYYY-MM-DD)
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (for tomorrow from {{currentDate}})", "time": "14:00" } }

- Message: "Next Monday appointment book karna hai, subah 10 baje." (I want to book an appointment for next Monday, at 10 in the morning.)
  (Assuming {{currentDate}} makes "Next Monday" resolve to a specific YYYY-MM-DD)
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (for next Monday from {{currentDate}})", "time": "10:00" } }

- Message: "Can I come tomorrow afternoon?"
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (for tomorrow from {{currentDate}})", "time": "14:00" } }

- Message: "Book me for 2nd June at 11"
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (for 2nd June, ensure year based on {{currentDate}})", "time": "11:00" } }

- Message: "I'd like to book an appointment for a tooth cleaning next Monday at 2pm."
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (next Monday from {{currentDate}})", "time": "14:00", "reason": "tooth cleaning" } }

- Message: "Reschedule my appointment to next Friday"
  Output: { "intent": "reschedule_appointment", "entities": { "date": "YYYY-MM-DD (next Friday from {{currentDate}})" } }
  
- Message: "Reschedule my appointment on {{contextualDate}} to same day at 3pm" (assuming {{contextualDate}} is set and bot asked for new time)
  Output: { "intent": "reschedule_appointment", "entities": { "date": "{{contextualDate}}", "time": "15:00" } }

- Message: "Mera appointment agle Friday ko reschedule kar do." (Reschedule my appointment to next Friday.)
  Output: { "intent": "reschedule_appointment", "entities": { "date": "YYYY-MM-DD (next Friday from {{currentDate}})" } }

- Message: "Cancel my appointment on 3rd June"
  Output: { "intent": "cancel_appointment", "entities": { "date": "YYYY-MM-DD (for 3rd June)" } }

- Message: "I need to cancel my appointment."
  Output: { "intent": "cancel_appointment", "entities": {} }

Conversational Follow-ups (After the bot has asked a question):
- Bot asked: "What day were you thinking of?"
  User message: "Tomorrow"
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (tomorrow from {{currentDate}})" } }

- Bot asked: "What day were you thinking of?"
  User message: "Kal ke liye." (For tomorrow.)
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (tomorrow from {{currentDate}})" } }

- Bot asked: "What day were you thinking of?"
  User message: "June 2nd"
  Output: { "intent": "book_appointment", "entities": { "date": "YYYY-MM-DD (June 2nd, infer year from {{currentDate}})" } }

- Bot asked: "Okay, for [date]. What time would you like to come in?"
  User message: "2pm"
  Output: { "intent": "book_appointment", "entities": { "time": "14:00" } }

- Bot asked: "Okay, for [date]. What time would you like to come in?"
  User message: "subah 10 baje" (10 in the morning)
  Output: { "intent": "book_appointment", "entities": { "time": "10:00" } }

- Bot asked: "And what is the reason for your visit?"
  User message: "A checkup"
  Output: { "intent": "book_appointment", "entities": { "reason": "A checkup" } }

- Bot asked: "And what is the reason for your visit?"
  User message: "Dard hai." (There is pain.)
  Output: { "intent": "book_appointment", "entities": { "reason": "Dard hai" } }

- Bot asked: "Your appointment is on {{contextualDate}}. What new date and time would you like?"
  User message: "Same day at 4pm"
  Output: { "intent": "reschedule_appointment", "entities": { "date": "{{contextualDate}}", "time": "16:00" } }

- Bot asked: "Your appointment is on {{contextualDate}}. What new date and time would you like?"
  User message: "Next Monday at 10am"
  Output: { "intent": "reschedule_appointment", "entities": { "date": "YYYY-MM-DD (next Monday from {{currentDate}})", "time": "10:00" } }


Other Common Patient Intents:
- Message: "Hello", "Hi", "Namaste" -> { "intent": "greeting", "entities": {} }
- Message: "Thanks", "Thank you", "Dhanyawad" -> { "intent": "thank_you", "entities": {} }
- Message: "What are your hours?" -> { "intent": "faq_opening_hours", "entities": {} }

Doctor Commands (senderType will be 'doctor', typically messages starting with '/'):
- Message: "/pause bookings from 2024-08-01 to 2024-08-05"
  Output: { "intent": "pause_bookings", "entities": { "start_date": "2024-08-01", "end_date": "2024-08-05" } }

- Message: "/pause bookings from tomorrow"
  Output: { "intent": "pause_bookings", "entities": { "start_date": "YYYY-MM-DD (tomorrow from {{currentDate}})" } }

- Message: "/resume bookings"
  Output: { "intent": "resume_bookings", "entities": {} }

- Message: "/cancel all meetings today"
  Output: { "intent": "cancel_all_meetings_today", "entities": {} }

- Message: "/cancel John Doe appointment"
  Output: { "intent": "cancel_appointment", "entities": { "patient_name": "John Doe" } }

- Message: "/cancel Anika Sharma appointment for tomorrow"
  Output: { "intent": "cancel_appointment", "entities": { "patient_name": "Anika Sharma", "date": "YYYY-MM-DD (tomorrow from {{currentDate}})" } }

- Message: "/reschedule Jane Smith to next Monday at 3pm"
  Output: { "intent": "reschedule_appointment", "entities": { "patient_name": "Jane Smith", "date": "YYYY-MM-DD (next Monday from {{currentDate}})", "time": "15:00" } }

General Instructions:
- If no specific intent from the list above is recognized, use "other".
- Prioritize doctor commands if the message starts with '/'.
- Parse dates relative to {{currentDate}} unless {{contextualDate}} is highly relevant (e.g. "same day").
- If year is omitted for a date, assume current year or next year if the date has passed in the current year.
- Convert times to HH:mm (24-hour) format.
- Extract the reason for the visit if provided with a booking request.

User Message: {{{message}}}

Output JSON:
`,
});


const recognizeIntentFlow = ai.defineFlow(
  {
    name: 'recognizeIntentFlow',
    inputSchema: recognizeIntentPromptInputSchema, // Use the extended schema
    outputSchema: RecognizeIntentPromptOutputSchema, // The flow itself outputs based on the prompt's schema
  },
  async (input) => { // Input type will match recognizeIntentPromptInputSchema
    console.log('[Intent Recognition Flow] Internal flow input (with currentDate & contextualDate):', JSON.stringify(input));
    const {output} = await prompt(input); // Pass the whole input
    if (!output) {
        console.error('[Intent Recognition Flow] Failed to produce output from AI model for message:', input.message);
        return {
            intent: 'other',
            entities: { error: 'Failed to recognize intent from AI model.'}
        }
    }
    console.log('[Intent Recognition Flow] Internal flow output from AI:', JSON.stringify(output));
    const entities = output.entities || {};
    return { ...output, entities };
  }
);
