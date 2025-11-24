import fs from 'node:fs';
import path from 'node:path';

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${formatDate(date)} ${hours}:${minutes}:${seconds}`;
}

export function getDailyNoteFilePath(workspaceRoot: string, date = new Date()): string {
  const root = path.resolve(workspaceRoot);
  const fileName = `${formatDate(date)}-note.md`;
  return path.join(root, fileName);
}

export function appendMarkNoteEntry(
  workspaceRoot: string,
  userEntry: string,
  assistantEntry: string,
): string {
  const now = new Date();
  const notePath = getDailyNoteFilePath(workspaceRoot, now);
  const timestamp = formatTimestamp(now);
  const lines = [
    timestamp,
    '```',
    userEntry || '',
    '```',
    '```',
    assistantEntry || '',
    '```',
    '',
  ];
  fs.appendFileSync(notePath, lines.join('\n'));
  return notePath;
}
