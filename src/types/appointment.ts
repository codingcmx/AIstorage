export interface Appointment {
  rowIndex: number;
  calendarEventId: string;
  patientName: string;
  reason: string;
  appointmentDate: string;
  appointmentTime: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'cancelled' | 'rescheduled';
  notes?: string;
} 