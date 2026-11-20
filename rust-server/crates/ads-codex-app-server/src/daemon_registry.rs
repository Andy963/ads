use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, Weak};

use tokio::sync::Mutex;

use crate::{CodexAppServerClient, RpcError, RpcResult, SpawnOptions};

pub type ClientFuture = Pin<Box<dyn Future<Output = RpcResult<CodexAppServerClient>> + Send>>;
pub type ClientFactory = Arc<dyn Fn(SpawnOptions) -> ClientFuture + Send + Sync>;

#[derive(Clone)]
struct RegistryEntry {
    options: SpawnOptions,
    client: CodexAppServerClient,
    instance_id: String,
}

pub struct CodexAppServerDaemonRegistry {
    entries: Mutex<HashMap<String, RegistryEntry>>,
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    factory: ClientFactory,
}

impl CodexAppServerDaemonRegistry {
    pub fn new() -> Arc<Self> {
        Self::with_factory(|options| {
            Box::pin(async move { CodexAppServerClient::spawn(options).await })
        })
    }

    pub fn with_factory<F>(factory: F) -> Arc<Self>
    where
        F: Fn(SpawnOptions) -> ClientFuture + Send + Sync + 'static,
    {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            factory: Arc::new(factory),
        })
    }

    pub async fn get_or_start(
        self: &Arc<Self>,
        project_id: &str,
        options: SpawnOptions,
    ) -> RpcResult<CodexAppServerClient> {
        let project_id = project_id.trim();
        if project_id.is_empty() {
            return Err(RpcError::InvalidResponse(
                "project id is required for a daemon".to_string(),
            ));
        }
        let start_lock = {
            let mut locks = self.start_locks.lock().await;
            Arc::clone(
                locks
                    .entry(project_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = start_lock.lock().await;

        let existing = {
            let entries = self.entries.lock().await;
            entries.get(project_id).cloned()
        };
        if let Some(entry) = existing {
            if !entry.client.is_closed() && entry.options == options {
                return Ok(entry.client);
            }
            self.remove_and_close(project_id, Some(&entry.instance_id))
                .await;
        }

        let client = (self.factory)(options.clone()).await?;
        if let Err(error) = client.start().await {
            client.close().await;
            return Err(error);
        }
        let instance_id = client.instance_id().to_string();
        self.entries.lock().await.insert(
            project_id.to_string(),
            RegistryEntry {
                options,
                client: client.clone(),
                instance_id: instance_id.clone(),
            },
        );
        let registry: Weak<Self> = Arc::downgrade(self);
        let project_id_for_close = project_id.to_string();
        let _ = client
            .on_close(move |_| {
                if let Some(registry) = registry.upgrade() {
                    let project_id = project_id_for_close.clone();
                    let instance_id = instance_id.clone();
                    tokio::spawn(async move {
                        registry
                            .remove_and_close(&project_id, Some(&instance_id))
                            .await;
                    });
                }
            })
            .await;
        Ok(client)
    }

    pub async fn stop(&self, project_id: &str) {
        self.remove_and_close(project_id.trim(), None).await;
    }

    pub async fn stop_all(&self) {
        let project_ids = self
            .entries
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for project_id in project_ids {
            self.stop(&project_id).await;
        }
    }

    pub async fn size(&self) -> usize {
        self.entries.lock().await.len()
    }

    pub async fn has(&self, project_id: &str) -> bool {
        self.entries.lock().await.contains_key(project_id.trim())
    }

    async fn remove_and_close(&self, project_id: &str, expected_instance: Option<&str>) {
        let entry = {
            let mut entries = self.entries.lock().await;
            if entries
                .get(project_id)
                .is_some_and(|entry| expected_instance.is_none_or(|id| entry.instance_id == id))
            {
                entries.remove(project_id)
            } else {
                None
            }
        };
        if let Some(entry) = entry {
            entry.client.close().await;
        }
    }
}

pub fn get_shared_daemon_registry() -> Arc<CodexAppServerDaemonRegistry> {
    static SHARED: OnceLock<Arc<CodexAppServerDaemonRegistry>> = OnceLock::new();
    Arc::clone(SHARED.get_or_init(CodexAppServerDaemonRegistry::new))
}
