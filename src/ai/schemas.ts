
/**
 * @fileOverview Shared Zod schemas for AI flows.
 * This file does NOT use the 'use server'; directive itself, allowing it
 * to export Zod schema objects freely for use in other modules.
 */
import {z} from 'genkit';

// Schema for input to the recognizeIntent function
export const RecognizeIntentInputSchema = z.object({
  message: z.string().describe('The message sent via WhatsApp.'),
  senderType: z.enum(['patient', 'doctor']).describe('The type of sender (patient or doctor).'),
});
export type RecognizeIntentInput = z.infer<typeof RecognizeIntentInputSchema>;

// Schema for the *full output* of the exported `recognizeIntent` function.
// This includes `originalMessage` which is added by the wrapper function.
export const RecognizeIntentFunctionOutputSchema = z.object({
  intent: z.string().describe('The intent of the message. Examples: book_appointment, reschedule_appointment, cancel_appointment, pause_bookings, resume_bookings, cancel_all_meetings_today, greeting, thank_you, faq_opening_hours, other.'),
  entities: z.object({
    date: z.string().optional().describe('The date for an appointment or command, e.g., "YYYY-MM-DD".'),
    time: z.string().optional().describe('The time for an appointment, e.g., "HH:MM" or "h:mm a".'),
    reason: z.string().optional().describe('The reason for a visit or appointment.'),
    patient_name: z.string().optional().describe("The patient's name for doctor commands."),
    start_date: z.string().optional().describe('The start date for pausing bookings, e.g., "YYYY-MM-DD".'),
    end_date: z.string().optional().describe('The end date for pausing bookings, e.g., "YYYY-MM-DD".'),
    error: z.string().optional().describe('An error message if intent recognition itself had an issue with understanding specific parts.')
  }).optional().describe('The extracted entities from the message. All entity fields are optional.'),
  originalMessage: z.string().describe('The original message text.'),
});
export type RecognizeIntentOutput = z.infer<typeof RecognizeIntentFunctionOutputSchema>;

// Schema for the *AI prompt's output* and the *internal flow's output*.
// This does NOT include `originalMessage` as it's added by the wrapper.
export const RecognizeIntentPromptOutputSchema = RecognizeIntentFunctionOutputSchema.omit({originalMessage: true});
export type RecognizeIntentPromptOutputType = z.infer<typeof RecognizeIntentPromptOutputSchema>;

