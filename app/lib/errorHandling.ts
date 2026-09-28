export function getUserFacingErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) {
    const normalized = error.trim();
    if (normalized.length > 0 && !normalized.toLowerCase().includes('typeerror') && !normalized.toLowerCase().includes('referenceerror') && !normalized.toLowerCase().includes('syntaxerror') && !normalized.toLowerCase().includes('networkerror')) {
      return normalized;
    }
  }

  if (error instanceof Error) {
    const raw = error.message?.trim();
    if (raw) {
      const lowered = raw.toLowerCase();
      if (lowered.includes('passwords must match') || lowered.includes('invalid') || lowered.includes('already') || lowered.includes('required') || lowered.includes('not found') || lowered.includes('expired') || lowered.includes('unauthorized') || lowered.includes('forbidden')) {
        return raw;
      }
    }
  }

  return 'Something went wrong. Please refresh the page and try again.';
}

export function logErrorForDiagnostics(context: string, error: unknown) {
  // Intentionally keep raw details in the server log / browser console while users only see safe copy.
  if (typeof console !== 'undefined') {
    console.error(context, error);
  }
}
