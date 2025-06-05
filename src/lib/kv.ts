import { createClient } from '@vercel/kv';

// Initialize client using environment variables provided by Vercel
export const kv = createClient({
  url: process.env.KV_URL!,
  token: process.env.KV_REST_API_TOKEN!,
}); 