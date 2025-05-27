import {genkit} from 'genkit';
import {googleAI} from '@genkit-ai/googleai';

// This initializes Genkit with the Google AI plugin.
// It relies on the GOOGLE_API_KEY environment variable for authentication with Gemini.
export const ai = genkit({
  plugins: [googleAI()],
  model: 'googleai/gemini-2.0-flash', // Default model for text generation
});
