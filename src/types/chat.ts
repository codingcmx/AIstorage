
export interface Message {
  id: string;
  sender: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
  intent?: string;
  entities?: Record<string, any>;
  isLoading?: boolean;
}

export type SenderType = 'patient' | 'doctor';
