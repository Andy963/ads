export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

export function estimateMessagesTokens(messages: Array<{ content?: string; text?: string; role?: string }>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content ?? message.text ?? "") + 4, 0);
}
