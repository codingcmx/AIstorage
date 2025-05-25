// src/services/whatsapp-service.ts
'use server';

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
  console.warn(
    'WhatsApp API credentials (ACCESS_TOKEN or PHONE_NUMBER_ID) are not set. Sending messages will fail.'
  );
}

interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends a text message via the WhatsApp Business API.
 * @param to The recipient's phone number (with country code, no + or 00).
 * @param text The message content.
 * @returns A promise that resolves to an object indicating success or failure.
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string
): Promise<SendMessageResponse> {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    const errorMsg =
      'WhatsApp API credentials not configured. Cannot send message.';
    console.error(errorMsg);
    return {success: false, error: errorMsg};
  }

  const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: {
      preview_url: false, // Set to true if you want URL previews
      body: text,
    },
  };

  try {
    const response = await fetch(WHATSAPP_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error(
        'Error sending WhatsApp message:',
        response.status,
        responseData
      );
      const errorDetail =
        responseData.error?.message ||
        `Failed to send message, status: ${response.status}`;
      return {success: false, error: errorDetail};
    }

    console.log('WhatsApp message sent successfully:', responseData);
    return {success: true, messageId: responseData.messages?.[0]?.id};
  } catch (error) {
    console.error('Exception sending WhatsApp message:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown exception';
    return {success: false, error: errorMessage};
  }
}

// Example: sendWhatsAppMessage('15550001234', 'Hello from MediMate AI!');
