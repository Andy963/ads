use std::sync::Arc;

use ads_telegram::{
    TelegramBot, TelegramBotOptions, load_connector_config, validate_connector_config,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = load_connector_config(&std::env::vars().collect());
    validate_connector_config(&config)?;
    let bot = Arc::new(TelegramBot::new(TelegramBotOptions::new(config))?);
    bot.run().await?;
    Ok(())
}
