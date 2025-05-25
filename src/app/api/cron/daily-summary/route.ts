// src/app/api/cron/daily-summary/route.ts
import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import { getAppointmentsFromSheet } from '@/services/google-sheets-service';
import { generateDailySummary, GenerateDailySummaryInput } from '@/ai/flows/daily-summary';
import { sendWhatsAppMessage } from '@/services/whatsapp-service';
import { format } from 'date-fns';

const DOCTOR_WHATSAPP_NUMBER = process.env.DOCTOR_WHATSAPP_NUMBER;
const CRON_SECRET = process.env.CRON_SECRET; // Optional: Add a secret to protect this endpoint

export async function GET(request: NextRequest) {
  // Optional: Basic security check if CRON_SECRET is set
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      console.warn('Daily summary cron: Unauthorized access attempt.');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  if (!DOCTOR_WHATSAPP_NUMBER) {
    console.error('Daily summary cron: DOCTOR_WHATSAPP_NUMBER is not set in environment variables.');
    return NextResponse.json({ error: 'Doctor WhatsApp number not configured' }, { status: 500 });
  }

  try {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    console.log(`Daily summary cron: Fetching appointments for ${todayStr}`);

    const appointmentsFromSheet = await getAppointmentsFromSheet({ date: todayStr, status: 'booked' });

    if (!appointmentsFromSheet || appointmentsFromSheet.length === 0) {
      const noAppointmentMessage = `Good morning, Doctor! There are no appointments scheduled for today, ${format(new Date(), 'EEEE, MMMM do')}.`;
      await sendWhatsAppMessage(DOCTOR_WHATSAPP_NUMBER, noAppointmentMessage);
      console.log('Daily summary cron: No appointments for today. Sent notification to doctor.');
      return NextResponse.json({ message: 'No appointments today, summary sent.' });
    }

    const formattedAppointments: GenerateDailySummaryInput['appointments'] = appointmentsFromSheet.map(app => ({
      patientName: app.patientName,
      time: app.appointmentTime, // Assumes HH:MM format
      reason: app.reason,
    }));

    console.log(`Daily summary cron: Generating summary for ${formattedAppointments.length} appointments.`);
    const { summary } = await generateDailySummary({ appointments: formattedAppointments });
    
    const fullSummaryMessage = `Good morning, Doctor! Here is your summary for today, ${format(new Date(), 'EEEE, MMMM do')}:\n\n${summary}`;

    const sendResult = await sendWhatsAppMessage(DOCTOR_WHATSAPP_NUMBER, fullSummaryMessage);

    if (sendResult.success) {
      console.log('Daily summary cron: Successfully generated and sent daily summary to doctor.');
      return NextResponse.json({ message: 'Daily summary sent successfully.' });
    } else {
      console.error('Daily summary cron: Failed to send summary via WhatsApp:', sendResult.error);
      return NextResponse.json({ error: 'Failed to send summary via WhatsApp', details: sendResult.error }, { status: 500 });
    }

  } catch (error: any) {
    console.error('Daily summary cron: Error generating or sending daily summary:', error);
    return NextResponse.json({ error: 'Failed to process daily summary', details: error.message || String(error) }, { status: 500 });
  }
}
