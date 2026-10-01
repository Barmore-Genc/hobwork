use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use hobwork_relay::api::{self, State};
use hobwork_relay::apns::{ApnsClient, ApnsConfig};
use hobwork_relay::attest::{APPLE_ROOT_PEM, Verifier};
use hobwork_relay::config::Config;
use hobwork_relay::limits::Limits;
use hobwork_relay::store::SqliteStore;
use hobwork_relay::tasks;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let config = Config::from_env()?;
    let key_pem = std::fs::read_to_string(&config.apns_key_file).with_context(|| {
        format!(
            "HOBWORK_RELAY_APNS_KEY_FILE {} cannot be read",
            config.apns_key_file.display()
        )
    })?;
    let apns = ApnsClient::new(ApnsConfig {
        key_pem,
        key_id: config.apns_key_id,
        team_id: config.apns_team_id,
        topic: config.apns_topic,
    })?;
    let store = SqliteStore::open(&config.db)
        .with_context(|| format!("cannot open the database at {}", config.db.display()))?;
    let state = Arc::new(State {
        store: Arc::new(store),
        apns: Arc::new(apns),
        verifier: Verifier::new(config.app_id, APPLE_ROOT_PEM)?,
        limits: Limits::default(),
        trusted_proxies: config.trusted_proxies,
        clock: Arc::new(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64
        }),
    });

    tokio::spawn(tasks::run(state.clone()));
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!("listening on {}", config.listen);
    axum::serve(
        listener,
        api::router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn shutdown() {
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate => {}
    }
}
