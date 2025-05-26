
// src/app/api/whatsapp/webhook/route.ts
import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';

export async function GET(request: NextRequest) {
  console.log('\n\n---------------------------------------------------------');
  console.log('[WHATSAPP WEBHOOK GET] Handler execution started.');

  const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  console.log(`[WHATSAPP WEBHOOK GET] Value of WHATSAPP_VERIFY_TOKEN from process.env: "${WHATSAPP_VERIFY_TOKEN}" (Type: ${typeof WHATSAPP_VERIFY_TOKEN})`);

  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  console.log(`[WHATSAPP WEBHOOK GET] Received verification request params:`);
  console.log(`  hub.mode: "${mode}"`);
  console.log(`  hub.verify_token (from Meta): "${token}"`);
  console.log(`  hub.challenge: "${challenge}"`);

  if (!WHATSAPP_VERIFY_TOKEN || WHATSAPP_VERIFY_TOKEN.trim() === '') {
    console.error("[WHATSAPP WEBHOOK GET] CRITICAL: WHATSAPP_VERIFY_TOKEN is not set, empty, or undefined in your environment variables (.env file)!");
    console.log('---------------------------------------------------------\n');
    // Meta expects a 403 if verification fails due to token mismatch.
    return NextResponse.json({error: 'Webhook internal configuration error: Verify token not set on server.'}, {status: 403});
  }

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    if (challenge) {
      console.log('[WHATSAPP WEBHOOK GET] Verification successful! Responding with challenge.');
      console.log('---------------------------------------------------------\n');
      return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    } else {
      console.error('[WHATSAPP WEBHOOK GET] Challenge is missing in verification request, though token matched.');
      console.log('---------------------------------------------------------\n');
      return NextResponse.json({error: 'Challenge missing in request'}, {status: 400});
    }
  } else {
    console.error('[WHATSAPP WEBHOOK GET] Verification failed. Mode or token mismatch.');
    if (mode !== 'subscribe') {
        console.error(`  Reason for failure: hub.mode is "${mode}", expected "subscribe".`);
    }
    if (token !== WHATSAPP_VERIFY_TOKEN) {
        console.error(`  Reason for failure: hub.verify_token "${token}" (from Meta) does not match expected WHATSAPP_VERIFY_TOKEN "${WHATSAPP_VERIFY_TOKEN}" (from .env).`);
    }
    console.log('---------------------------------------------------------\n');
    return NextResponse.json({error: 'Failed verification - token or mode mismatch'}, {status: 403});
  }
}

export async function POST(request: NextRequest) {
  console.log('\n\n---------------------------------------------------------');
  console.log('[WHATSAPP WEBHOOK POST] Handler execution started.');
  try {
    const body = await request.json();
    console.log('[WHATSAPP WEBHOOK POST] Received message body:', JSON.stringify(body, null, 2));

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
                  const messageTimestamp = message.timestamp; // WhatsApp timestamp is in seconds as a string

                  console.log(`[WHATSAPP WEBHOOK POST] Processing text message from ${from}: "${text}" (ID: ${messageId}, Timestamp: ${messageTimestamp})`);

                  // Dynamically import to avoid issues if processWhatsAppMessage is not ready or has circular deps at module load
                  const { processWhatsAppMessage } = await import('@/ai/flows/process-whatsapp-message-flow');

                  // Process the message using a Genkit flow
                  await processWhatsAppMessage({
                    senderId: from,
                    messageText: text,
                    messageId: messageId,
                    timestamp: new Date(parseInt(messageTimestamp, 10) * 1000),
                    senderName: value.contacts?.[0]?.profile?.name || 'User',
                  });
                } else {
                  console.log(`[WHATSAPP WEBHOOK POST] Received non-text message type: ${message.type} from ${message.from}`);
                  // Optionally handle other message types
                }
              }
            }
          }
        }
      }
      console.log('[WHATSAPP WEBHOOK POST] Successfully processed event(s).');
      console.log('---------------------------------------------------------\n');
      return NextResponse.json({status: 'success'}, {status: 200});
    } else {
      // Not a WhatsApp API event
      console.warn('[WHATSAPP WEBHOOK POST] Received non-WhatsApp API event:', body);
      console.log('---------------------------------------------------------\n');
      return NextResponse.json({error: 'Not a WhatsApp event'}, {status: 400});
    }
  } catch (error) {
    console.error('[WHATSAPP WEBHOOK POST] Error processing WhatsApp message:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.log('---------------------------------------------------------\n');
    return NextResponse.json({error: 'Internal server error', details: errorMessage }, {status: 500});
  }
}
