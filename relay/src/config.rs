use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use ipnet::IpNet;

pub struct Config {
    pub listen: SocketAddr,
    pub db: PathBuf,
    pub apns_key_file: PathBuf,
    pub apns_key_id: String,
    pub apns_team_id: String,
    pub apns_topic: String,
    pub app_id: String,
    pub trusted_proxies: Vec<IpNet>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub fn parse_proxies(value: &str) -> Result<Vec<IpNet>> {
    value
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|entry| {
            entry
                .parse::<IpNet>()
                .or_else(|_| entry.parse::<std::net::IpAddr>().map(IpNet::from))
                .with_context(|| format!("HOBWORK_RELAY_TRUSTED_PROXIES: {entry} is not an IP or CIDR range"))
        })
        .collect()
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let Some(apns_key_file) = var("HOBWORK_RELAY_APNS_KEY_FILE") else {
            bail!("HOBWORK_RELAY_APNS_KEY_FILE is not set")
        };
        let Some(apns_key_id) = var("HOBWORK_RELAY_APNS_KEY_ID") else {
            bail!("HOBWORK_RELAY_APNS_KEY_ID is not set")
        };
        let apns_team_id = var("HOBWORK_RELAY_APNS_TEAM_ID").unwrap_or_else(|| "63QQLP356Q".into());
        let apns_topic = var("HOBWORK_RELAY_APNS_TOPIC").unwrap_or_else(|| "dev.bgenc.hobwork".into());
        Ok(Self {
            listen: var("HOBWORK_RELAY_LISTEN")
                .unwrap_or_else(|| "0.0.0.0:8080".into())
                .parse()
                .context("HOBWORK_RELAY_LISTEN is not an address and port")?,
            db: var("HOBWORK_RELAY_DB").unwrap_or_else(|| "data/relay.db".into()).into(),
            apns_key_file: apns_key_file.into(),
            apns_key_id,
            app_id: var("HOBWORK_RELAY_APP_ID").unwrap_or_else(|| format!("{apns_team_id}.{apns_topic}")),
            apns_team_id,
            apns_topic,
            trusted_proxies: parse_proxies(&var("HOBWORK_RELAY_TRUSTED_PROXIES").unwrap_or_default())?,
        })
    }
}
