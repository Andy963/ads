use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::markdown::format_thinking_status;

pub const DEFAULT_TYPING_INTERVAL_MS: u64 = 4_000;
pub const DEFAULT_THINKING_INTERVAL_MS: u64 = 1_000;

#[async_trait]
pub trait PromptStatusTarget: Send + Sync {
    async fn send_message(&self, text: String) -> Result<Option<i64>, String>;
    async fn edit_message(&self, message_id: i64, text: String) -> Result<(), String>;
    async fn delete_message(&self, message_id: i64) -> Result<(), String>;
    async fn send_typing(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy)]
pub struct PromptStatusOptions {
    pub typing_interval: Duration,
    pub thinking_interval: Duration,
}

impl Default for PromptStatusOptions {
    fn default() -> Self {
        Self {
            typing_interval: Duration::from_millis(DEFAULT_TYPING_INTERVAL_MS),
            thinking_interval: Duration::from_millis(DEFAULT_THINKING_INTERVAL_MS),
        }
    }
}

struct PromptStatusState {
    stopped: bool,
    message_id: Option<i64>,
    timers: Vec<JoinHandle<()>>,
}

pub struct PromptStatusReporter<T: PromptStatusTarget + 'static> {
    target: Arc<T>,
    options: PromptStatusOptions,
    state: Arc<Mutex<PromptStatusState>>,
}

impl<T: PromptStatusTarget + 'static> PromptStatusReporter<T> {
    pub fn new(target: Arc<T>, options: PromptStatusOptions) -> Self {
        Self {
            target,
            options: PromptStatusOptions {
                typing_interval: options.typing_interval.max(Duration::from_millis(1)),
                thinking_interval: options.thinking_interval.max(Duration::from_millis(1)),
            },
            state: Arc::new(Mutex::new(PromptStatusState {
                stopped: true,
                message_id: None,
                timers: Vec::new(),
            })),
        }
    }

    pub async fn start(&self) {
        let message_id = self
            .target
            .send_message(format_thinking_status(0))
            .await
            .ok()
            .flatten();
        {
            let mut state = self.state.lock().await;
            state.stopped = false;
            state.message_id = message_id;
        }
        let typing_target = Arc::clone(&self.target);
        let typing_interval = self.options.typing_interval;
        let typing_timer = tokio::spawn(async move {
            let _ = typing_target.send_typing().await;
            loop {
                tokio::time::sleep(typing_interval).await;
                if typing_target.send_typing().await.is_err() {
                    break;
                }
            }
        });

        let thinking_target = Arc::clone(&self.target);
        let thinking_interval = self.options.thinking_interval;
        let state_handle = self.state.clone();
        let thinking_timer = tokio::spawn(async move {
            let mut frame = 1;
            loop {
                tokio::time::sleep(thinking_interval).await;
                let message_id = {
                    let state = state_handle.lock().await;
                    if state.stopped {
                        break;
                    }
                    state.message_id
                };
                if let Some(message_id) = message_id {
                    let _ = thinking_target
                        .edit_message(message_id, format_thinking_status(frame))
                        .await;
                }
                frame = (frame + 1) % 4;
            }
        });

        self.state
            .lock()
            .await
            .timers
            .extend([typing_timer, thinking_timer]);
    }

    pub async fn complete(&self) {
        self.finish().await;
    }

    pub async fn fail(&self) {
        self.finish().await;
    }

    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        state.stopped = true;
        for timer in state.timers.drain(..) {
            timer.abort();
        }
    }

    async fn finish(&self) {
        let message_id = {
            let mut state = self.state.lock().await;
            if state.stopped {
                return;
            }
            state.stopped = true;
            for timer in state.timers.drain(..) {
                timer.abort();
            }
            state.message_id.take()
        };
        if let Some(message_id) = message_id {
            let _ = self.target.delete_message(message_id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct FakeTarget {
        sent: StdMutex<Vec<String>>,
        edits: StdMutex<Vec<String>>,
        deleted: StdMutex<Vec<i64>>,
        typing: StdMutex<u32>,
    }

    #[async_trait]
    impl PromptStatusTarget for FakeTarget {
        async fn send_message(&self, text: String) -> Result<Option<i64>, String> {
            self.sent.lock().expect("sent").push(text);
            Ok(Some(42))
        }
        async fn edit_message(&self, _message_id: i64, text: String) -> Result<(), String> {
            self.edits.lock().expect("edits").push(text);
            Ok(())
        }
        async fn delete_message(&self, message_id: i64) -> Result<(), String> {
            self.deleted.lock().expect("deleted").push(message_id);
            Ok(())
        }
        async fn send_typing(&self) -> Result<(), String> {
            *self.typing.lock().expect("typing") += 1;
            Ok(())
        }
    }

    #[tokio::test]
    async fn animates_and_deletes_the_status_message() {
        let target = Arc::new(FakeTarget::default());
        let reporter = PromptStatusReporter::new(
            Arc::clone(&target),
            PromptStatusOptions {
                typing_interval: Duration::from_millis(20),
                thinking_interval: Duration::from_millis(20),
            },
        );
        reporter.start().await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        reporter.complete().await;
        assert_eq!(target.sent.lock().expect("sent").as_slice(), ["thinking"]);
        assert!(target.typing.lock().expect("typing").to_owned() >= 2);
        assert!(
            target
                .edits
                .lock()
                .expect("edits")
                .iter()
                .any(|text| text == "thinking.")
        );
        assert_eq!(target.deleted.lock().expect("deleted").as_slice(), [42]);
    }
}
