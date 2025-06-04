export function isValidCalendarId(id: string | undefined | null): id is string {
  return typeof id === 'string' && id.length > 0;
}

export function isValidRowIndex(index: number | undefined | null): index is number {
  return typeof index === 'number' && index > 0;
} 