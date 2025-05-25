'use server';

/**
 * @fileOverview Recognizes the intent of a message from a patient or doctor.
 *
 * - recognizeIntent - A function that recognizes the intent of a message.
 * - RecognizeIntentInput - The input type for the recognizeIntent function.
 * - RecognizeIntentOutput - The return type for the recognizeIntent function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const RecognizeIntentInputSchema = z.object({
  message: z.string().describe('The message sent via WhatsApp.'),
  senderType: z.enum(['patient', 'doctor']).describe('The type of sender (patient or doctor).'),
});
export type RecognizeIntentInput = z.infer<typeof RecognizeIntentInputSchema>;

const RecognizeIntentOutputSchema = z.object({
  intent: z.string().describe('The intent of the message. Examples: book_appointment, reschedule_appointment, cancel_appointment, pause_bookings, resume_bookings, cancel_all_meetings_today, greeting, thank_you, faq_opening_hours, other.'),
  entities: z.record(z.any()).describe('The extracted entities from the message. Examples: { date: "YYYY-MM-DD", time: "HH:MM", reason: "description", patient_name: "Patient Name", start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" }'),
  originalMessage: z.string().describe('The original message text.'),
});
export type RecognizeIntentOutput = z.infer<typeof RecognizeIntentOutputSchema>;

export async function recognizeIntent(input: RecognizeIntentInput): Promise<RecognizeIntentOutput> {
  const result = await recognizeIntentFlow(input);
  return { ...result, originalMessage: input.message };
}

const prompt = ai.definePrompt({
  name: 'recognizeIntentPrompt',
  input: {schema: RecognizeIntentInputSchema},
  output: {schema: RecognizeIntentOutputSchema.omit({originalMessage: true})}, // originalMessage is added by the wrapper
  prompt: `You are a WhatsApp bot for a doctor's clinic. Your task is to identify the intent and extract entities from messages.
Message is from a {{senderType}}.

Common Patient Intents:
- book_appointment: User wants to schedule a new appointment.
  Entities: { date: "YYYY-MM-DD", time: "HH:MM" (24hr) or "h:mm a", reason: "Visit reason" }
  Examples:
    "I'd like to book an appointment for a tooth cleaning next Monday at 2pm." -> { intent: "book_appointment", entities: { date: "YYYY-MM-DD (next Monday)", time: "14:00", reason: "tooth cleaning" } }
    "Need to see the doctor for a checkup on July 25th around 10 AM." -> { intent: "book_appointment", entities: { date: "2024-07-25", time: "10:00", reason: "checkup" } }
- reschedule_appointment: User wants to change an existing appointment.
  Entities: { date: "YYYY-MM-DD", time: "HH:MM" or "h:mm a" } (for the new time)
  Examples:
    "Can I reschedule my appointment to tomorrow at 3pm?" -> { intent: "reschedule_appointment", entities: { date: "YYYY-MM-DD (tomorrow)", time: "15:00" } }
- cancel_appointment: User wants to cancel an appointment.
  Entities: {}
  Examples:
    "I need to cancel my appointment." -> { intent: "cancel_appointment", entities: {} }
- greeting: User sends a greeting.
  Entities: {}
  Examples: "Hello", "Hi" -> { intent: "greeting", entities: {} }
- thank_you: User expresses thanks.
  Entities: {}
  Examples: "Thanks", "Thank you" -> { intent: "thank_you", entities: {} }
- faq_opening_hours: User asks about clinic hours.
  Entities: {}
  Examples: "What are your hours?" -> { intent: "faq_opening_hours", entities: {} }

Common Doctor Commands (senderType will be 'doctor'):
- /pause bookings from [start_date] to [end_date]: Doctor wants to pause new bookings.
  Entities: { start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" } (end_date is optional)
  Examples:
    "/pause bookings from 2024-08-01 to 2024-08-05" -> { intent: "pause_bookings", entities: { start_date: "2024-08-01", end_date: "2024-08-05" } }
    "/pause bookings from tomorrow" -> { intent: "pause_bookings", entities: { start_date: "YYYY-MM-DD (tomorrow)" } }
- /resume bookings: Doctor wants to resume bookings.
  Entities: {}
  Examples:
    "/resume bookings" -> { intent: "resume_bookings", entities: {} }
- /cancel all meetings today: Doctor wants to cancel all appointments for the current day.
  Entities: {}
  Examples:
    "/cancel all meetings today" -> { intent: "cancel_all_meetings_today", entities: {} }
- /cancel [patient_name] appointment: Doctor wants to cancel a specific patient's appointment.
  Entities: { patient_name: "Patient's Full Name" }
  Examples:
    "/cancel John Doe appointment" -> { intent: "cancel_appointment", entities: { patient_name: "John Doe" } }
    "/cancel Anika Sharma's appointment for today" -> { intent: "cancel_appointment", entities: { patient_name: "Anika Sharma", date: "YYYY-MM-DD (today)"}}
- /reschedule [patient_name] to [new_date] at [new_time]: Doctor wants to reschedule a specific patient's appointment.
  Entities: { patient_name: "Patient's Full Name", date: "YYYY-MM-DD", time: "HH:MM" or "h:mm a" }
  Examples:
    "/reschedule Jane Smith to 2024-08-10 at 3pm" -> { intent: "reschedule_appointment", entities: { patient_name: "Jane Smith", date: "2024-08-10", time: "15:00" } }

If no specific intent is recognized, use "other".
Prioritize doctor commands if the message starts with '/'.
Parse dates and times. If year is omitted for a date, assume current year or next year if the date has passed.
Convert times to HH:MM (24-hour) format if possible, but retain original if ambiguous or if only "morning/afternoon" is given.

Message: {{{message}}}

Output JSON:
`,
});

const recognizeIntentFlow = ai.defineFlow(
  {
    name: 'recognizeIntentFlow',
    inputSchema: RecognizeIntentInputSchema,
    outputSchema: RecognizeIntentOutputSchema.omit({originalMessage: true}),
  },
  async input => {
    console.log('Recognizing intent for:', input);
    const {output} = await prompt(input);
    if (!output) {
        console.error('Intent recognition failed to produce output for message:', input.message);
        return {
            intent: 'other',
            entities: { error: 'Failed to recognize intent.'}
        }
    }
    console.log('Recognized intent:', output);
    return output;
  }
);
