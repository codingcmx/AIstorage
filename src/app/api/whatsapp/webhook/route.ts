// src/app/api/whatsapp/webhook/route.ts
import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import {processWhatsAppMessage} from '@/ai/flows/process-whatsapp-message-flow'; // We'll create this flow

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

/**
 * Handles GET requests for webhook verification with Meta.
 * @param request The incoming NextRequest.
 * @returns A NextResponse with the challenge token or an error.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified successfully!');
    return NextResponse.json(Number(challenge), {status: 200});
  } else {
    console.error(
      'Failed webhook verification. Make sure WHATSAPP_VERIFY_TOKEN is set correctly.'
    );
    return NextResponse.json({error: 'Failed verification'}, {status: 403});
  }
}

/**
 * Handles POST requests with incoming WhatsApp messages.
 * @param request The incoming NextRequest.
 * @returns A NextResponse indicating success or failure.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    console.log('Received WhatsApp message:', JSON.stringify(body, null, 2));

    // Validate that this is a WhatsApp API event
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            const value = change.value;
            if (value.messages) {
              for (const message of value.messages) {
                if (message.type === 'text') {
                  const from = message.from; // Sender's phone number
                  const text = message.text.body; // Message content
                  const messageId = message.id; // Message ID

                  console.log(`Message from ${from}: ${text} (ID: ${messageId})`);

                  // Process the message using a Genkit flow
                  // The flow will handle intent recognition, actions, and crafting a response
                  await processWhatsAppMessage({
                    senderId: from,
                    messageText: text,
                    messageId: messageId,
                    timestamp: new Date(message.timestamp * 1000), // WhatsApp timestamp is in seconds
                    // You might want to pass more context from `value.contacts` if available, e.g., profile name
                    senderName: value.contacts?.[0]?.profile?.name || 'User',
                  });
                } else {
                  console.log(`Received non-text message type: ${message.type} from ${message.from}`);
                  // Optionally handle other message types (image, audio, location, etc.)
                  // For now, we can acknowledge or send a generic "I only understand text" response.
                }
              }
            }
          }
        }
      }
      return NextResponse.json({status: 'success'}, {status: 200});
    } else {
      // Not a WhatsApp API event
      return NextResponse.json({error: 'Not a WhatsApp event'}, {status: 400});
    }
  } catch (error)
 {
    console.error('Error processing WhatsApp message:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({error: 'Internal server error', details: errorMessage }, {status: 500});
  }
}
