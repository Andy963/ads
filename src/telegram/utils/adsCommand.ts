const ADS_INLINE_PREFIX = "ads.";
const ADS_SLASH_PREFIX = `/${ADS_INLINE_PREFIX}`;

/**
 * Parses inline `/ads.<command>` Telegram inputs (e.g. `/ads.status arg1 arg2`)
 * into the argument list expected by `handleAdsCommand`.
 * Returns `null` when the text is not an inline ADS command.
 */
export function parseInlineAdsCommand(text: string | undefined | null): string[] | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(ADS_SLASH_PREFIX)) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) {
    return null;
  }

  const [firstToken, ...restTokens] = tokens;
  const withoutSlash = firstToken.slice(1);
  const mentionIndex = withoutSlash.indexOf("@");
  const commandSegment = mentionIndex === -1 ? withoutSlash : withoutSlash.slice(0, mentionIndex);

  if (!commandSegment.toLowerCase().startsWith(ADS_INLINE_PREFIX)) {
    return null;
  }

  const subcommand = commandSegment.slice(ADS_INLINE_PREFIX.length);
  if (!subcommand) {
    return null;
  }

  return [subcommand.toLowerCase(), ...restTokens];
}

/**
 * Parses plain-text ADS commands (e.g. "ads.status") that are sent as regular
 * chat messages instead of Telegram slash commands.
 */
export function parsePlainAdsCommand(text: string | undefined | null): string[] | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  // Slash 开头的交给 parseInlineAdsCommand 处理
  if (trimmed.startsWith("/")) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) {
    return null;
  }

  const [firstToken, ...restTokens] = tokens;
  const lowerFirst = firstToken.toLowerCase();

  if (!lowerFirst.startsWith(ADS_INLINE_PREFIX)) {
    return null;
  }

  const subcommand = lowerFirst.slice(ADS_INLINE_PREFIX.length);
  if (!subcommand) {
    return null;
  }

  return [subcommand.toLowerCase(), ...restTokens];
}
