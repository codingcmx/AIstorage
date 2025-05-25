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
  senderType: z.enum(['patient', 'doctor']).describe('The type of sender.'),
});
export type RecognizeIntentInput = z.infer<typeof RecognizeIntentInputSchema>;

const RecognizeIntentOutputSchema = z.object({
  intent: z.string().describe('The intent of the message.'),
  entities: z.record(z.any()).describe('The extracted entities from the message.'),
});
export type RecognizeIntentOutput = z.infer<typeof RecognizeIntentOutputSchema>;

export async function recognizeIntent(input: RecognizeIntentInput): Promise<RecognizeIntentOutput> {
  return recognizeIntentFlow(input);
}

const prompt = ai.definePrompt({
  name: 'recognizeIntentPrompt',
  input: {schema: RecognizeIntentInputSchema},
  output: {schema: RecognizeIntentOutputSchema},
  prompt: `You are a WhatsApp bot that helps to manage appointments for a doctor's clinic. Your task is to identify the intent of the message and extract the entities from the message.

  The message is from a {{senderType}}, it could be either a 'patient' or a 'doctor'.

  Here are some examples of intents and entities:

  - Intent: book_appointment
    Entities: {
      date: '2024-07-01',
      time: '10:00',
      reason: 'Tooth cleaning'
    }

  - Intent: reschedule_appointment
    Entities: {
      date: '2024-07-05',
      time: '11:00'
    }

  - Intent: cancel_appointment
    Entities: {}

  - Intent: pause_bookings
    Entities: {
      date: '2024-06-25'
    }

  - Intent: resume_bookings
    Entities: {}

  - Intent: cancel_all_meetings_today
    Entities: {}

  - Intent: cancel_appointment
    Entities: {
      patient_name: 'Anika Sharma'
    }

  Now, identify the intent and extract the entities from the following message:

  Message: {{{message}}}

  Make sure that the output is a valid JSON object.
  `, 
});

const recognizeIntentFlow = ai.defineFlow(
  {
    name: 'recognizeIntentFlow',
    inputSchema: RecognizeIntentInputSchema,
    outputSchema: RecognizeIntentOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);
