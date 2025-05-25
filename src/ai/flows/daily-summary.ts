'use server';
/**
 * @fileOverview Generates a daily summary of appointments for the doctor.
 *
 * - generateDailySummary - A function that generates the daily summary.
 * - GenerateDailySummaryInput - The input type for the generateDailySummary function.
 * - GenerateDailySummaryOutput - The return type for the generateDailySummary function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const GenerateDailySummaryInputSchema = z.object({
  appointments: z
    .array(
      z.object({
        patientName: z.string(),
        time: z.string(),
        reason: z.string(),
      })
    )
    .describe('An array of appointments for the day.'),
});
export type GenerateDailySummaryInput = z.infer<typeof GenerateDailySummaryInputSchema>;

const GenerateDailySummaryOutputSchema = z.object({
  summary: z.string().describe('A summary of the day\'s appointments.'),
});
export type GenerateDailySummaryOutput = z.infer<typeof GenerateDailySummaryOutputSchema>;

export async function generateDailySummary(input: GenerateDailySummaryInput): Promise<GenerateDailySummaryOutput> {
  return generateDailySummaryFlow(input);
}

const prompt = ai.definePrompt({
  name: 'generateDailySummaryPrompt',
  input: {schema: GenerateDailySummaryInputSchema},
  output: {schema: GenerateDailySummaryOutputSchema},
  prompt: `You are a helpful AI assistant that generates a daily summary of appointments for a doctor.\n\nHere are the appointments for today:\n\n{{#each appointments}}\n- {{time}}: {{patientName}} - {{reason}}\n{{/each}}\n\nGenerate a concise and informative summary of these appointments for the doctor.`,
});

const generateDailySummaryFlow = ai.defineFlow(
  {
    name: 'generateDailySummaryFlow',
    inputSchema: GenerateDailySummaryInputSchema,
    outputSchema: GenerateDailySummaryOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);
