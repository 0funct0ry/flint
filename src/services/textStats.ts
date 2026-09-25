export function countWords(content: string): number {
  const trimmed = content.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export function countChars(content: string): number {
  return content.length;
}
