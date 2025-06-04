export type MessageType = 'text' | 'interactive' | 'template';

export interface WebhookInput {
  messageId: string;
  senderId: string;
  senderName?: string;
  messageType: MessageType;
  message: string;
  entities?: {
    patient_name?: string;
    appointment_date?: string;
    appointment_time?: string;
    appointment_reason?: string;
  };
} 