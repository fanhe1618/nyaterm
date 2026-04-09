//! SSH tunnel manager for local, remote, and dynamic (SOCKS5) port forwarding.

use crate::config::{self, TunnelConfig};
use crate::error::{AppError, AppResult};
use crate::ssh::SshHandler;
use russh::client;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

struct TunnelHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
}

pub struct TunnelManager {
    active: Arc<Mutex<HashMap<String, TunnelHandle>>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn is_open(&self, tunnel_id: &str) -> bool {
        self.active.lock().await.contains_key(tunnel_id)
    }

    pub async fn open(&self, tunnel: &TunnelConfig, app: &AppHandle) -> AppResult<()> {
        {
            let active = self.active.lock().await;
            if active.contains_key(&tunnel.id) {
                return Ok(());
            }
        }

        let ssh_handle = crate::ssh::create_ssh_handle(
            app,
            tunnel
                .connection_id
                .as_deref()
                .ok_or_else(|| AppError::Channel("Tunnel has no connection_id".to_string()))?,
        )
        .await?;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let bind_addr = if tunnel.bind_localhost {
            "127.0.0.1"
        } else {
            "0.0.0.0"
        };

        match tunnel.tunnel_type.as_str() {
            "local" => {
                let listener = TcpListener::bind(format!("{}:{}", bind_addr, tunnel.listen_port))
                    .await
                    .map_err(|e| {
                        AppError::Channel(format!(
                            "Failed to bind local port {}: {}",
                            tunnel.listen_port, e
                        ))
                    })?;
                let target_host = tunnel.target_host.clone();
                let target_port = tunnel.target_port;
                tokio::spawn(Self::run_local_tunnel(
                    listener,
                    ssh_handle,
                    target_host,
                    target_port,
                    shutdown_rx,
                ));
            }
            "remote" => {
                let target_host = tunnel.target_host.clone();
                let target_port = tunnel.target_port;
                let listen_port = tunnel.listen_port;
                let listen_addr = bind_addr.to_string();
                tokio::spawn(Self::run_remote_tunnel(
                    ssh_handle,
                    listen_addr,
                    listen_port,
                    target_host,
                    target_port,
                    shutdown_rx,
                ));
            }
            "dynamic" => {
                let listener = TcpListener::bind(format!("{}:{}", bind_addr, tunnel.listen_port))
                    .await
                    .map_err(|e| {
                        AppError::Channel(format!(
                            "Failed to bind SOCKS5 port {}: {}",
                            tunnel.listen_port, e
                        ))
                    })?;
                tokio::spawn(Self::run_dynamic_tunnel(listener, ssh_handle, shutdown_rx));
            }
            other => {
                return Err(AppError::Channel(format!("Unknown tunnel type: {}", other)));
            }
        }

        self.active.lock().await.insert(
            tunnel.id.clone(),
            TunnelHandle {
                shutdown_tx: Some(shutdown_tx),
            },
        );

        tracing::info!(tunnel_id = %tunnel.id, tunnel_type = %tunnel.tunnel_type, "Tunnel opened");
        Ok(())
    }

    pub async fn close(&self, tunnel_id: &str) {
        let mut active = self.active.lock().await;
        if let Some(mut handle) = active.remove(tunnel_id) {
            if let Some(tx) = handle.shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!(tunnel_id = %tunnel_id, "Tunnel closed");
        }
    }

    async fn run_local_tunnel(
        listener: TcpListener,
        ssh_handle: Arc<tokio::sync::Mutex<client::Handle<SshHandler>>>,
        target_host: String,
        target_port: u16,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accept = listener.accept() => {
                    match accept {
                        Ok((mut local_stream, peer_addr)) => {
                            let handle_mtx = ssh_handle.clone();
                            let host = target_host.clone();
                            tokio::spawn(async move {
                                let channel = {
                                    let handle = handle_mtx.lock().await;
                                    match handle.channel_open_direct_tcpip(
                                        &host,
                                        target_port.into(),
                                        &peer_addr.ip().to_string(),
                                        peer_addr.port().into(),
                                    ).await {
                                        Ok(ch) => ch,
                                        Err(e) => {
                                            tracing::warn!("direct-tcpip failed: {}", e);
                                            return;
                                        }
                                    }
                                };
                                let mut stream = channel.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut local_stream, &mut stream).await;
                            });
                        }
                        Err(e) => {
                            tracing::warn!("TCP accept failed: {}", e);
                        }
                    }
                }
            }
        }
    }

    async fn run_remote_tunnel(
        ssh_handle: Arc<tokio::sync::Mutex<client::Handle<SshHandler>>>,
        listen_addr: String,
        listen_port: u16,
        _target_host: String,
        _target_port: u16,
        shutdown_rx: oneshot::Receiver<()>,
    ) {
        {
            let handle = ssh_handle.lock().await;
            if let Err(e) = handle.tcpip_forward(&listen_addr, listen_port.into()).await {
                tracing::warn!("tcpip_forward request failed: {}", e);
                return;
            }
        }
        tracing::info!(
            listen = %format!("{}:{}", listen_addr, listen_port),
            "Remote tunnel forwarding requested"
        );

        let _ = shutdown_rx.await;

        let handle = ssh_handle.lock().await;
        let _ = handle
            .cancel_tcpip_forward(&listen_addr, listen_port.into())
            .await;
    }

    async fn run_dynamic_tunnel(
        listener: TcpListener,
        ssh_handle: Arc<tokio::sync::Mutex<client::Handle<SshHandler>>>,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accept = listener.accept() => {
                    match accept {
                        Ok((stream, peer_addr)) => {
                            let handle = ssh_handle.clone();
                            tokio::spawn(Self::handle_socks5_connection(stream, handle, peer_addr));
                        }
                        Err(e) => {
                            tracing::warn!("SOCKS5 accept failed: {}", e);
                        }
                    }
                }
            }
        }
    }

    async fn handle_socks5_connection(
        mut stream: tokio::net::TcpStream,
        ssh_handle: Arc<tokio::sync::Mutex<client::Handle<SshHandler>>>,
        peer_addr: std::net::SocketAddr,
    ) {
        let mut buf = [0u8; 2];
        if stream.read_exact(&mut buf).await.is_err() {
            return;
        }
        if buf[0] != 0x05 {
            return;
        }
        let nmethods = buf[1] as usize;
        let mut methods = vec![0u8; nmethods];
        if stream.read_exact(&mut methods).await.is_err() {
            return;
        }
        if stream.write_all(&[0x05, 0x00]).await.is_err() {
            return;
        }

        let mut header = [0u8; 4];
        if stream.read_exact(&mut header).await.is_err() {
            return;
        }
        if header[0] != 0x05 || header[1] != 0x01 {
            let _ = stream
                .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return;
        }

        let (target_host, target_port) = match header[3] {
            0x01 => {
                let mut addr = [0u8; 4];
                if stream.read_exact(&mut addr).await.is_err() {
                    return;
                }
                let host = format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]);
                let mut port_buf = [0u8; 2];
                if stream.read_exact(&mut port_buf).await.is_err() {
                    return;
                }
                (host, u16::from_be_bytes(port_buf))
            }
            0x03 => {
                let mut len = [0u8; 1];
                if stream.read_exact(&mut len).await.is_err() {
                    return;
                }
                let mut domain = vec![0u8; len[0] as usize];
                if stream.read_exact(&mut domain).await.is_err() {
                    return;
                }
                let host = String::from_utf8_lossy(&domain).to_string();
                let mut port_buf = [0u8; 2];
                if stream.read_exact(&mut port_buf).await.is_err() {
                    return;
                }
                (host, u16::from_be_bytes(port_buf))
            }
            0x04 => {
                let mut addr = [0u8; 16];
                if stream.read_exact(&mut addr).await.is_err() {
                    return;
                }
                let host = std::net::Ipv6Addr::from(addr).to_string();
                let mut port_buf = [0u8; 2];
                if stream.read_exact(&mut port_buf).await.is_err() {
                    return;
                }
                (host, u16::from_be_bytes(port_buf))
            }
            _ => return,
        };

        let channel = match {
            let handle = ssh_handle.lock().await;
            handle
                .channel_open_direct_tcpip(
                    &target_host,
                    target_port.into(),
                    &peer_addr.ip().to_string(),
                    peer_addr.port().into(),
                )
                .await
        } {
            Ok(ch) => ch,
            Err(e) => {
                tracing::warn!("SOCKS5 direct-tcpip failed: {}", e);
                let _ = stream
                    .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                    .await;
                return;
            }
        };

        let _ = stream
            .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;

        let mut ssh_stream = channel.into_stream();
        let _ = tokio::io::copy_bidirectional(&mut stream, &mut ssh_stream).await;
    }

    /// Auto-open tunnels for a connection that just connected.
    pub async fn auto_open_for_connection(&self, app: &AppHandle, connection_id: &str) {
        let tunnels = match config::load_tunnels(app) {
            Ok(t) => t,
            Err(_) => return,
        };

        for tunnel in &tunnels {
            if tunnel.auto_open && tunnel.connection_id.as_deref() == Some(connection_id) {
                if let Err(e) = self.open(tunnel, app).await {
                    tracing::warn!(
                        tunnel_id = %tunnel.id,
                        "Failed to auto-open tunnel: {}",
                        e
                    );
                }
            }
        }
    }

    /// Close all auto-open tunnels associated with a connection.
    pub async fn close_auto_tunnels_for_connection(&self, app: &AppHandle, connection_id: &str) {
        let tunnels = match config::load_tunnels(app) {
            Ok(t) => t,
            Err(_) => return,
        };

        for tunnel in &tunnels {
            if tunnel.auto_open && tunnel.connection_id.as_deref() == Some(connection_id) {
                self.close(&tunnel.id).await;
            }
        }
    }
}
