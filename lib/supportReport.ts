export const SUPPORT_REPORT_CATEGORIES = [
  'Bug',
  'Billing',
  'Live Tutor',
  'AI Response',
  'Safety',
  'Feature Request',
  'Other',
] as const;

export type SupportReportCategory = typeof SUPPORT_REPORT_CATEGORIES[number];

export type ValidatedSupportReport = {
  category: SupportReportCategory;
  description: string;
  conversationId: string | null;
  messageId: string | null;
  appVersion: string | null;
};

function optionalIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function validateSupportReportPayload(payload: unknown): ValidatedSupportReport {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid report payload.');
  }

  const body = payload as Record<string, unknown>;
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!SUPPORT_REPORT_CATEGORIES.includes(category as SupportReportCategory)) {
    throw new Error('Choose a valid report category.');
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 10 || description.length > 4000) {
    throw new Error('Report description must be between 10 and 4,000 characters.');
  }

  return {
    category: category as SupportReportCategory,
    description,
    conversationId: optionalIdentifier(body.conversationId, 200),
    messageId: optionalIdentifier(body.messageId, 200),
    appVersion: optionalIdentifier(body.appVersion, 50),
  };
}
