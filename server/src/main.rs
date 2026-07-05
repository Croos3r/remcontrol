use remcontrol_server::{config, injector, ws};

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

    let ip = local_ip_address::local_ip()?;
    let payload = serde_json::json!({
        "ip": ip.to_string(),
        "port": cfg.port,
        "token": cfg.token,
    })
    .to_string();

    println!("remcontrol server");
    println!("  address : ws://{ip}:{}/ws", cfg.port);
    println!("  token   : {}", cfg.token);
    println!("  config  : {}", config_path.display());
    println!("\nScan with the remcontrol app:\n");
    qr2term::print_qr(&payload)?;

    let mdns = mdns_sd::ServiceDaemon::new()?;
    let service = mdns_sd::ServiceInfo::new(
        "_remcontrol._tcp.local.",
        "remcontrol",
        "remcontrol.local.",
        ip,
        cfg.port,
        None,
    )?;
    mdns.register(service)?;

    let commands = injector::spawn_enigo()?;
    let state = ws::AppState::new(cfg.token.clone(), commands);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    axum::serve(listener, ws::router(state)).await?;
    Ok(())
}
