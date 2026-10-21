const ERROR_EXCERPT_CHARS = 160;

export function extractJsonObject(input) {
  if (!input) throw new Error('Respons provider AI kosong');
  if (typeof input === 'object') return input;

  const cleaned = String(input)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // Fall through to one bounded, user-safe error below.
      }
    }
    throw new Error(`JSON provider AI tidak valid: ${cleaned.slice(0, ERROR_EXCERPT_CHARS)}`);
  }
}
