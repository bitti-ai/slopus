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

/// Which announced address to try first. Home and office LANs use
/// 192.168/16 and 10/8; 172.16/12 is often a Hyper-V or WSL adapter other
/// computers cannot reach, and link-local IPv6 needs a scope URLs drop.
fn address_rank(address: &SocketAddr) -> (u8, SocketAddr) {
    let rank = match address.ip() {
        IpAddr::V4(ip) if ip.octets()[0] == 192 || ip.octets()[0] == 10 => 0,
        IpAddr::V4(ip) if ip.is_private() => 1,
        IpAddr::V4(_) => 2,
        IpAddr::V6(_) => 3,
    };
    (rank, *address)
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
                        addresses.sort_by_key(address_rank);
                        addresses.dedup();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Needs a worker running on this network (`slopus-worker`).
    #[test]
    #[ignore]
    fn finds_a_running_worker() {
        let found = Arc::new(Mutex::new(Vec::new()));
        let seen = found.clone();
        let _daemon = browse(move |workers| *seen.lock().unwrap() = workers).unwrap();
        let started = std::time::Instant::now();
        while found.lock().unwrap().is_empty() {
            assert!(started.elapsed() < std::time::Duration::from_secs(15), "no worker announced itself");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        println!("{:?}", found.lock().unwrap());
    }

    #[test]
    fn lan_addresses_are_tried_before_virtual_adapters_and_ipv6() {
        let mut addresses: Vec<SocketAddr> = ["[fe80::1]:1", "172.19.144.1:1", "8.8.8.8:1", "192.168.88.232:1", "172.19.144.1:1"]
            .iter().map(|text| text.parse().unwrap()).collect();
        addresses.sort_by_key(address_rank);
        addresses.dedup();
        assert_eq!(addresses.iter().map(ToString::to_string).collect::<Vec<_>>(),
            vec!["192.168.88.232:1", "172.19.144.1:1", "8.8.8.8:1", "[fe80::1]:1"]);
    }
}
