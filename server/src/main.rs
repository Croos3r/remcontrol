use remcontrol_server::{
    config, injector, pairing_payload, pick_lan_ip, sanitize_hostname, token_fingerprint, ws,
};
use std::net::{IpAddr, SocketAddr};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config_path = config::default_path();
    let cfg = if std::env::args().any(|a| a == "--reset-token") {
        let cfg = config::Config::reset_token(&config_path)?;
        println!("Token reset.");
        cfg
    } else {
        config::Config::load_or_create(&config_path)?
    };

    let no_mdns = std::env::args().any(|a| a == "--no-mdns");
    let advertise_mdns = cfg.advertise_mdns && !no_mdns;

    // `--bind-addr IP` overrides the config's bind_addr for one run, useful
    // when the auto-detected IP is wrong (e.g., a VPN/Tailscale interface is
    // the default route). The same IP is advertised in the QR.
    let args: Vec<String> = std::env::args().collect();
    let cli_bind: Option<String> = (0..args.len())
        .filter(|i| args[*i] == "--bind-addr")
        .filter_map(|i| args.get(i + 1).cloned())
        .next();
    let hostname = sanitize_hostname(hostname::get().ok().and_then(|h| h.into_string().ok()));

    // Pick the LAN IP. Prefer the CLI / config override; otherwise enumerate
    // interfaces and pick a private IPv4 on a non-virtual interface so we
    // don't bind to a Tailscale/WireGuard/Docker IP the phone can't reach.
    // Fall back to the crate's heuristic only if our enumeration finds nothing.
    let ip: IpAddr = match cli_bind.as_deref().or(cfg.bind_addr.as_deref()) {
        Some(addr) => addr
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid bind_addr '{addr}': {e}"))?,
        None => match pick_lan_ip() {
            Ok(ip) => ip,
            Err(e) => {
                tracing::warn!("LAN IP detection failed ({e}); falling back to local_ip()");
                local_ip_address::local_ip()?
            }
        },
    };

    let bind_addr: SocketAddr = format!("{ip}:{}", cfg.port).parse()?;
    let payload = pairing_payload(&ip.to_string(), cfg.port, &cfg.token, &hostname);

    println!("remcontrol server");
    println!("  host      : {hostname}");
    println!("  address   : ws://{bind_addr}/ws");
    println!(
        "  token id  : {} (full token is in the QR code only)",
        token_fingerprint(&cfg.token)
    );
    println!("  config    : {}", config_path.display());
    println!(
        "  mdns      : {}",
        if advertise_mdns { "on" } else { "off" }
    );
    println!("\nScan with the remcontrol app:\n");
    if let Err(e) = qr2term::print_qr(&payload) {
        // The server is still usable via manual IP + token entry, but the
        // pairing UI is unavailable (L-3).
        tracing::error!(
            "could not render the QR code in this terminal: {e}. Pair manually with the IP, port and the token from the config file."
        );
    }

    if advertise_mdns {
        let mdns = mdns_sd::ServiceDaemon::new()?;
        let host_fqdn = format!("{hostname}.local.");
        let service = mdns_sd::ServiceInfo::new(
            "_remcontrol._tcp.local.",
            &hostname,
            &host_fqdn,
            ip,
            cfg.port,
            None,
        )?;
        mdns.register(service)?;
    }

    let commands = injector::spawn_enigo()?;
    let state = ws::AppState::with_origins(cfg.token.clone(), commands, cfg.allowed_origins);
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    axum::serve(
        listener,
        ws::router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
