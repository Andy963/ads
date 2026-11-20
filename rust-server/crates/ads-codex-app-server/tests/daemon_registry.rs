use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ads_codex_app_server::{
    ClientFactory, CodexAppServerClient, CodexAppServerDaemonRegistry, SpawnOptions,
};
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, split,
};
use tokio::sync::Mutex;

struct ServerSide {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl ServerSide {
    async fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line).await {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(line.trim()).ok(),
        }
    }

    async fn write(&mut self, value: Value) {
        self.writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .expect("server write");
        self.writer.flush().await.expect("server flush");
    }
}

fn fake_pair() -> (CodexAppServerClient, ServerSide) {
    let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
    let (client_reader, client_writer) = split(client_stream);
    let (server_reader, server_writer) = split(server_stream);
    (
        CodexAppServerClient::from_io(client_reader, client_writer),
        ServerSide {
            reader: BufReader::new(server_reader),
            writer: server_writer,
        },
    )
}

fn fake_factory(
    clients: Arc<Mutex<Vec<CodexAppServerClient>>>,
) -> (ClientFactory, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let factory_count = Arc::clone(&count);
    let factory: ClientFactory = Arc::new(move |_: SpawnOptions| {
        let clients = Arc::clone(&clients);
        let factory_count = Arc::clone(&factory_count);
        Box::pin(async move {
            factory_count.fetch_add(1, Ordering::AcqRel);
            let (client, mut server) = fake_pair();
            tokio::spawn(async move {
                while let Some(message) = server.read().await {
                    if message["method"] == "initialize" {
                        server
                            .write(json!({
                                "jsonrpc": "2.0",
                                "id": message["id"],
                                "result": {
                                    "userAgent": "fake",
                                    "codexHome": "/tmp/codex-home",
                                    "platformFamily": "unix",
                                    "platformOs": "linux"
                                }
                            }))
                            .await;
                    }
                }
            });
            clients.lock().await.push(client.clone());
            Ok(client)
        })
    });
    (factory, count)
}

#[tokio::test]
async fn reuses_a_daemon_and_restarts_when_options_change() {
    let clients = Arc::new(Mutex::new(Vec::new()));
    let (factory, factory_count) = fake_factory(Arc::clone(&clients));
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| factory(options));
    let options = SpawnOptions::default();

    let first = tokio::time::timeout(
        Duration::from_secs(2),
        registry.get_or_start("project-1", options.clone()),
    )
    .await
    .expect("first daemon timeout")
    .expect("first daemon");
    let reused = tokio::time::timeout(
        Duration::from_secs(2),
        registry.get_or_start("project-1", options),
    )
    .await
    .expect("reused daemon timeout")
    .expect("reused daemon");
    assert_eq!(first.instance_id(), reused.instance_id());
    assert_eq!(factory_count.load(Ordering::Acquire), 1);

    let changed = SpawnOptions {
        cwd: Some("/tmp/changed".into()),
        ..SpawnOptions::default()
    };
    let restarted = tokio::time::timeout(
        Duration::from_secs(2),
        registry.get_or_start("project-1", changed),
    )
    .await
    .expect("restarted daemon timeout")
    .expect("restarted daemon");
    assert_ne!(first.instance_id(), restarted.instance_id());
    assert!(first.is_closed());
    assert_eq!(factory_count.load(Ordering::Acquire), 2);
    assert_eq!(registry.size().await, 1);

    tokio::time::timeout(Duration::from_secs(2), registry.stop_all())
        .await
        .expect("stop all timeout");
    assert!(restarted.is_closed());
    assert_eq!(registry.size().await, 0);
    assert_eq!(clients.lock().await.len(), 2);
}

#[tokio::test]
async fn concurrent_starts_share_one_daemon_per_project() {
    let clients = Arc::new(Mutex::new(Vec::new()));
    let (factory, factory_count) = fake_factory(Arc::clone(&clients));
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| factory(options));
    let options = SpawnOptions::default();

    let (first, second) = tokio::join!(
        registry.get_or_start("project-concurrent", options.clone()),
        registry.get_or_start("project-concurrent", options),
    );
    let first = first.expect("first concurrent daemon");
    let second = second.expect("second concurrent daemon");
    assert_eq!(first.instance_id(), second.instance_id());
    assert_eq!(factory_count.load(Ordering::Acquire), 1);
    tokio::time::timeout(Duration::from_secs(2), registry.stop_all())
        .await
        .expect("stop all timeout");
}
