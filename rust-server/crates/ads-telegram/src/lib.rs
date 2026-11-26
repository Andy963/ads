mod bot;
mod config;
mod core_client;
mod error;
mod markdown;
mod model_commands;
mod prompt_status;
mod rate_limit;
mod telegram_api;

pub use bot::{TelegramBot, TelegramBotOptions};
pub use config::{TelegramConnectorConfig, load_connector_config, validate_connector_config};
pub use core_client::{
    AdsCoreClient, AdsCoreClientOptions, AdsEvent, ModelOption, ModelState, PromptTurnOptions,
};
pub use markdown::{chunk_message, escape_telegram_markdown_v2, format_thinking_status};
pub use model_commands::{
    ParsedModelCommand, allowed_reasoning_efforts, build_model_keyboard, find_model,
    format_model_menu, format_model_status, parse_model_callback, parse_model_command,
};
pub use prompt_status::{PromptStatusOptions, PromptStatusReporter, PromptStatusTarget};
pub use telegram_api::{
    TelegramApi, TelegramApiOptions, TelegramBotCommand, TelegramCallbackQuery, TelegramChat,
    TelegramMessage, TelegramUpdate, TelegramUser,
};
