export interface Message {
  type: 'user' | 'system';
  text: string;
  timestamp: string; // ISO 8601 string
}

export interface ConversationState {
  history: Message[];
  currentFlow?: 'booking' | 'rescheduling' | 'idle' | 'cancelling'; // Added 'cancelling' for clarity
  bookingDetails?: {
    date?: string; // YYYY-MM-DD
    time?: string; // HH:mm
    patientName?: string; // The name provided by user
    reason?: string;
  };
  lastActive: string; // ISO 8601 string of last interaction
} 