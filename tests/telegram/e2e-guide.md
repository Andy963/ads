# Telegram Bot E2E Testing Guide

## Prerequisites
1. Active Telegram Bot Token
2. Test Telegram Account
3. Bot running locally or on server

## Setup
```bash
# 1. Configure test environment
cp .env.telegram .env.telegram.test
vim .env.telegram.test  # Add your test bot token and user ID

# 2. Start bot in test mode
TELEGRAM_BOT_TOKEN=<test-token> \
TELEGRAM_ALLOWED_USERS=<your-user-id> \
TELEGRAM_ALLOWED_DIRS=/tmp,/home/test \
node dist/telegram/bot.js
```

## Test Scenarios

### 1. Basic Commands
- [ ] `/start` - Shows welcome message
- [ ] `/help` - Lists all commands
- [ ] `/status` - Shows system status
- [ ] `/pwd` - Shows current directory
- [ ] `/reset` - Resets session

### 2. Text Conversation
- [ ] Send "Hello" - Gets Codex response
- [ ] Send long message (>1000 chars) - Response chunked properly
- [ ] Send code block - Markdown formatted correctly

### 3. Image Upload
- [ ] Send single image - Codex analyzes it
- [ ] Send image with caption - Uses caption as prompt
- [ ] Send multiple images - All processed

### 4. File Upload
- [ ] Send text file (.txt) - Codex reads content
- [ ] Send JSON file - Codex parses data
- [ ] Send large file (>20MB) - Rejected with error
- [ ] Send PDF - Handled appropriately

### 5. URL Processing
- [ ] Send image URL - Downloads and analyzes
- [ ] Send file URL - Downloads and processes
- [ ] Send webpage URL - Codex accesses via web search
- [ ] Send multiple URLs - All processed correctly

### 6. Directory Management
- [ ] `/cd /tmp` - Changes directory
- [ ] `/cd /invalid` - Shows error (not in whitelist)
- [ ] `/pwd` - Confirms directory change

### 7. Thread Persistence
- [ ] Have conversation
- [ ] Restart bot
- [ ] Send message - Prompted to resume
- [ ] `/resume` - Continues previous conversation
- [ ] `/reset` - Starts new conversation

### 8. Model Selection
- [ ] `/model` - Shows current model
- [ ] `/model gpt-4` - Switches model
- [ ] Verify session reset after switch

### 9. Interrupt Mechanism
- [ ] Send long-running request
- [ ] `/stop` during execution
- [ ] Verify execution stops

### 10. Rate Limiting
- [ ] Send 15 requests rapidly
- [ ] Verify rate limit message after 10th request
- [ ] Wait 1 minute
- [ ] Verify requests work again

### 11. Error Handling
- [ ] Send invalid command - Gets helpful error
- [ ] Trigger Codex error - Shows user-friendly message
- [ ] Network interruption - Handles gracefully

### 12. Concurrent Users (if possible)
- [ ] Two users send messages simultaneously
- [ ] Verify sessions don't interfere
- [ ] Check both get correct responses

## Performance Tests
- [ ] Response time <2s for simple queries
- [ ] Image processing <30s
- [ ] File processing <1 min for normal files
- [ ] Message updates smooth (no flickering)

## Security Tests
- [ ] Unauthorized user access - Rejected
- [ ] Directory traversal attempt - Blocked
- [ ] Dangerous command - Warning shown
- [ ] Sensitive info in response - Filtered

## Cleanup
```bash
# Stop test bot
./telegram-bot.sh stop

# Clean test data
rm -rf .ads/temp/
rm .ads/telegram-threads.json
```

## Reporting Issues
Document any failures with:
- Command/action performed
- Expected result
- Actual result
- Error messages (if any)
- Screenshots (if relevant)
