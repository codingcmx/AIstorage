import { NextResponse } from 'next/server';
import { format, parse, addMinutes, isBefore, isAfter, startOfDay, endOfDay, isSameDay } from 'date-fns';
import { z } from 'zod';
import { retryOperation } from '@/lib/retry';
import { updateAppointmentInSheet, getAppointmentsForDate } from '@/services/sheets';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '@/services/calendar';
import { sendWhatsAppMessage } from '@/services/whatsapp';
import { isValidCalendarId, isValidRowIndex } from '@/lib/validators';
import { WebhookInput } from '@/types/whatsapp';

const webhookInputSchema = z.object({
  messageId: z.string(),
  senderId: z.string(),
  senderName: z.string().optional(),
  messageType: z.enum(['text', 'interactive', 'template']),
  message: z.string(),
  entities: z.object({
    patient_name: z.string().optional(),
    appointment_date: z.string().optional(),
    appointment_time: z.string().optional(),
    appointment_reason: z.string().optional(),
  }).optional(),
}) satisfies z.ZodType<WebhookInput>;

// ... existing code ...

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log('Received webhook body:', JSON.stringify(body, null, 2));

    const input = webhookInputSchema.parse(body);
    console.log(`[Process Flow - ${input.senderId}] Processing webhook for ${input.messageType} message`);

    let responseText = '';
    let responseType: 'text' | 'interactive' | 'template' = 'text';

    // ... rest of the code ...

  } catch (error) {
    console.error('Error processing webhook:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 