#!/usr/bin/env node

import '../utils/logSink.js';
import '../utils/env.js';

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const command = process.argv[2] || 'start';

const botPath = join(__dirname, 'bot.js');

const writeStdout = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
};

if (!existsSync(botPath)) {
  writeStderr('❌ Bot file not found. Please run: npm run build');
  process.exit(1);
}

switch (command) {
	case 'start': {
    writeStdout('🚀 Starting Telegram bot...');
    const bot = spawn('node', [botPath], {
      stdio: 'inherit',
      detached: false,
    });

    bot.on('error', (error) => {
      writeStderr(`❌ Failed to start bot: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });

    process.on('SIGINT', () => {
      bot.kill();
      process.exit(0);
    });
    break;
  }

	case 'help':
	case '--help':
	case '-h':
    writeStdout(`
	Telegram Bot CLI

Usage:
  ads-telegram [command]

Commands:
  start         Start the Telegram bot (default)
  help          Show this help message
  version       Show version information

Environment Variables:
  TELEGRAM_BOT_TOKEN          Your Telegram bot token (required)
  TELEGRAM_ALLOWED_USERS      Comma-separated user IDs (required)
  ALLOWED_DIRS                Comma-separated directory paths (shared by all endpoints)
  TELEGRAM_MAX_RPM            Max requests per minute (default: 10)
  SANDBOX_MODE                Sandbox mode: read-only|workspace-write|danger-full-access (shared)
  TELEGRAM_MODEL             AI model to use
  TELEGRAM_PROXY_URL         Optional HTTP proxy (e.g. http://127.0.0.1:7897)

Quick Start:
  1. Create .env file with your configuration (shared by Telegram & web)
  2. Run: ads-telegram start

	Documentation:
	  https://github.com/your-repo/ads-js#telegram-bot
`);
    break;

  case 'version':
  case '--version':
	case '-v': {
    const pkg = await import('../../package.json', { assert: { type: 'json' } });
    writeStdout(`Telegram Bot v${pkg.default.version}`);
    break;
  }

  default:
    writeStderr(`❌ Unknown command: ${command}`);
    writeStdout('Run "ads-telegram help" for usage information');
    process.exit(1);
}
