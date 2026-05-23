/** Helper to wrap skill-related text in a `<system-reminder>` for the model. */

export function wrapInSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}
