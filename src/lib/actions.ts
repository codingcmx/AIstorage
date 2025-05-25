
"use server";

import type { SenderType } from '@/types/chat';
import { recognizeIntent } from '@/ai/flows/intent-recognition';
import { generateDailySummary } from '@/ai/flows/daily-summary';
import type { GenerateDailySummaryInput } from '@/ai/flows/daily-summary';

interface HandleUserMessageResult {
  responseText: string;
  intent?: string;
  entities?: Record<string, any>;
}

// Helper function to generate a unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export async function handleUserMessage(messageText: string, senderType: SenderType): Promise<HandleUserMessageResult> {
  try {
    // Simulate doctor commands locally if they are simple and don't need complex entity extraction
    if (senderType === 'doctor') {
      if (messageText.toLowerCase().startsWith('/pause bookings till')) {
        const date = messageText.substring('/pause bookings till'.length).trim();
        return { responseText: `Okay, I've paused bookings until ${date}. Patients will be notified.` };
      }
      if (messageText.toLowerCase() === '/resume bookings') {
        return { responseText: "Bookings have been resumed. Patients can now book appointments." };
      }
      if (messageText.toLowerCase() === '/cancel all meetings today') {
        return { responseText: "All meetings for today have been cancelled. Affected patients will be notified." };
      }
      if (messageText.toLowerCase().startsWith('/cancel') && messageText.includes('appointment')) {
         // More complex cancellation like /cancel Anika Sharma appointment would ideally use intent recognition
         // For this demo, we can use a simplified response or pass it to recognizeIntent
         const parts = messageText.split(' ');
         const patientName = parts.length > 2 && !parts[1].startsWith('/') ? parts.slice(1, -1).join(' ') : "Unknown Patient";
         if (patientName !== "Unknown Patient") {
            return { responseText: `Appointment for ${patientName} has been cancelled.` };
         }
      }
    }

    const { intent, entities } = await recognizeIntent({ message: messageText, senderType });

    let responseText = "I'm not sure how to help with that. Can you try rephrasing?";

    // Simulate responses based on recognized intent
    // In a real system, these would trigger further actions (DB updates, Calendar API calls, etc.)
    switch (intent) {
      case 'book_appointment':
        responseText = `Okay, I'll help you book an appointment.`;
        if (entities.reason) responseText += ` Reason: ${entities.reason}.`;
        if (entities.date) responseText += ` Date: ${entities.date}.`;
        if (entities.time) responseText += ` Time: ${entities.time}.`;
        responseText += `\n\nPlease confirm these details or provide any missing information.`;
        break;
      case 'reschedule_appointment':
        responseText = `Sure, I can help you reschedule.`;
        if (entities.date) responseText += ` New date: ${entities.date}.`;
        if (entities.time) responseText += ` New time: ${entities.time}.`;
        responseText += `\n\nIs this correct?`;
        break;
      case 'cancel_appointment':
         if (senderType === 'doctor' && entities.patient_name) {
            responseText = `Appointment for patient ${entities.patient_name} has been cancelled.`;
        } else {
            responseText = "Your appointment has been cancelled.";
        }
        break;
      case 'pause_bookings':
        responseText = `Bookings will be paused.`;
        if (entities.date) responseText += ` Until: ${entities.date}.`;
        break;
      case 'resume_bookings':
        responseText = "Bookings are now resumed.";
        break;
      case 'cancel_all_meetings_today':
        responseText = "All meetings for today have been cancelled.";
        break;
      case 'greeting':
        responseText = "Hello! How can I help you today?";
        break;
      case 'thank_you':
        responseText = "You're welcome!";
        break;
      case 'faq_opening_hours':
        responseText = "The clinic is open from 9 AM to 5 PM, Monday to Friday.";
        break;
      // ... other intents
    }

    return { responseText, intent, entities };

  } catch (error) {
    console.error("Error in handleUserMessage:", error);
    return { responseText: "Sorry, I encountered an error. Please try again." };
  }
}

export async function getDailySummaryAction(): Promise<string> {
  try {
    // Mock appointment data for the demo
    const mockAppointments: GenerateDailySummaryInput['appointments'] = [
      { patientName: "Anika Sharma", time: "10:00 AM", reason: "Tooth cleaning" },
      { patientName: "Rohan Verma", time: "11:30 AM", reason: "Implant consultation" },
      { patientName: "Priya Singh", time: "02:00 PM", reason: "Routine check-up" },
    ];

    if (mockAppointments.length === 0) {
        return "No appointments scheduled for today.";
    }

    const { summary } = await generateDailySummary({ appointments: mockAppointments });
    return summary;
  } catch (error) {
    console.error("Error in getDailySummaryAction:", error);
    return "Sorry, I couldn't fetch the daily summary due to an error.";
  }
}
