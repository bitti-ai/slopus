//! mDNS: workers announce themselves on the local network and Slopus listens.
use super::protocol::{WorkerInfo, PROTOCOL_VERSION, SERVICE_TYPE};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
};

/// A worker seen on the network. Its HTTP info is fetched separately.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Announced {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) addresses: Vec<SocketAddr>,
}

fn host_label(name: &str) -> String {
    let label: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(50)
        .collect();
    if label.is_empty() { "slopus-worker".into() } else { label }
}

/// Keeps announcing this worker for as long as the returned daemon lives.
pub(crate) fn advertise(info: &WorkerInfo, port: u16) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
    let host = format!("{}-{}.local.", host_label(&super::server::computer_name()), &info.id[..6.min(info.id.len())]);
    let protocol = PROTOCOL_VERSION.to_string();
    let properties = [
        ("id", info.id.as_str()),
        ("name", info.name.as_str()),
        ("version", info.version.as_str()),
        ("protocol", protocol.as_str()),
    ];
    let service = ServiceInfo::new(SERVICE_TYPE, &info.id, &host, "", port, &properties[..])
        .map_err(|error| error.to_string())?
        .enable_addr_auto();
    daemon.register(service).map_err(|error| error.to_string())?;
    Ok(daemon)
}

/// Browses in the background and calls `changed` with every worker currently
/// announced whenever that set changes.
pub(crate) fn browse(changed: impl Fn(Vec<Announced>) + Send + 'static) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
    let events = daemon.browse(SERVICE_TYPE).map_err(|error| error.to_string())?;
    std::thread::Builder::new()
        .name("worker-discovery".into())
        .spawn(move || {
            let mut seen: HashMap<String, Announced> = HashMap::new();
            while let Ok(event) = events.recv() {
                let before = seen.clone();
                match event {
                    ServiceEvent::ServiceResolved(service) => {
                        let Some(id) = service.get_property_val_str("id").map(str::to_string) else { continue };
                        let mut addresses: Vec<SocketAddr> = service
                            .get_addresses()
                            .iter()
                            .map(|ip| ip.to_ip_addr())
                            .filter(|ip| !ip.is_loopback() || service.get_addresses().len() == 1)
                            .map(|ip| SocketAddr::new(ip, service.get_port()))
                            .collect();
                        // IPv4 first: link-local IPv6 needs a scope that URLs drop.
                        addresses.sort_by_key(|address| matches!(address.ip(), IpAddr::V6(_)));
                        seen.insert(service.get_fullname().to_string(), Announced {
                            name: service.get_property_val_str("name").unwrap_or(&id).to_string(),
                            id,
                            addresses,
                        });
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        seen.remove(&fullname);
                    }
                    _ => continue,
                }
                if seen != before {
                    changed(seen.values().cloned().collect());
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(daemon)
}
