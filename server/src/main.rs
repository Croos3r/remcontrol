use remcontrol_server::{
    config, injector, pairing_payload, sanitize_hostname, token_fingerprint, ws,
};
use std::net::SocketAddr;

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

    let ip = local_ip_address::local_ip()?;
    let hostname = sanitize_hostname(hostname::get().ok().and_then(|h| h.into_string().ok()));
    // Bind to the configured address, or default to the discovered LAN IP so
    // the server is reachable on the LAN but not exposed on every interface
    // (H-4, L-4).
    let bind_ip = cfg.bind_addr.clone().unwrap_or_else(|| ip.to_string());
    let bind_addr: SocketAddr = format!("{bind_ip}:{}", cfg.port).parse()?;
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
