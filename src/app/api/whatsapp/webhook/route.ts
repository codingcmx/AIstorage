// src/app/api/whatsapp/webhook/route.ts
import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import {processWhatsAppMessage} from '@/ai/flows/process-whatsapp-message-flow';

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

  console.log(`[WHATSAPP WEBHOOK GET] Received verification request:`);
  console.log(`  hub.mode: ${mode}`);
  console.log(`  hub.verify_token: ${token} (this is what Meta sent)`);
  console.log(`  hub.challenge: ${challenge}`);
  console.log(`  Expected WHATSAPP_VERIFY_TOKEN (from .env): ${WHATSAPP_VERIFY_TOKEN}`);

  if (!WHATSAPP_VERIFY_TOKEN) {
    console.error("[WHATSAPP WEBHOOK GET] CRITICAL: WHATSAPP_VERIFY_TOKEN is not set in your environment variables!");
    // Don't expose this in the response to Meta, but it's a server-side issue.
    return NextResponse.json({error: 'Webhook internal configuration error'}, {status: 500});
  }

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    if (challenge) {
      console.log('[WHATSAPP WEBHOOK GET] Verification successful! Responding with challenge.');
      // Meta expects the challenge to be echoed back exactly as received, as plain text.
      return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    } else {
      console.error('[WHATSAPP WEBHOOK GET] Challenge is missing in verification request, though token matched.');
      return NextResponse.json({error: 'Challenge missing in request'}, {status: 400});
    }
  } else {
    console.error('[WHATSAPP WEBHOOK GET] Verification failed. Mode or token mismatch.');
    if (mode !== 'subscribe') {
        console.error(`  Reason: hub.mode is "${mode}", expected "subscribe".`);
    }
    if (token !== WHATSAPP_VERIFY_TOKEN) {
        console.error(`  Reason: hub.verify_token "${token}" does not match expected WHATSAPP_VERIFY_TOKEN "${WHATSAPP_VERIFY_TOKEN}".`);
    }
    return NextResponse.json({error: 'Failed verification - token or mode mismatch'}, {status: 403});
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
                  await processWhatsAppMessage({
                    senderId: from,
                    messageText: text,
                    messageId: messageId,
                    timestamp: new Date(message.timestamp * 1000), // WhatsApp timestamp is in seconds
                    senderName: value.contacts?.[0]?.profile?.name || 'User',
                  });
                } else {
                  console.log(`Received non-text message type: ${message.type} from ${message.from}`);
                  // Optionally handle other message types
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
  } catch (error) {
    console.error('Error processing WhatsApp message:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({error: 'Internal server error', details: errorMessage }, {status: 500});
  }
}
