use std::{collections::BTreeMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};

#[derive(Clone, Default)]
pub(super) struct CancellationRegistry(Arc<Mutex<BTreeMap<String, Arc<AtomicBool>>>>);

impl CancellationRegistry {
    pub(super) fn register(&self, id: &str) -> Result<RunningTurn, String> {
        let mut running = self.0.lock().map_err(|_| "Agent runtime lock failed.")?;
        if running.contains_key(id) { return Err("This agent request is already running.".into()); }
        let flag = Arc::new(AtomicBool::new(false));
        running.insert(id.to_owned(), flag.clone());
        Ok(RunningTurn { registry: self.clone(), id: id.to_owned(), flag })
    }

    pub(super) fn cancel(&self, id: &str) -> bool {
        self.0.lock().ok().and_then(|running| running.get(id).cloned())
            .is_some_and(|flag| { flag.store(true, Ordering::Release); true })
    }
}

pub(super) struct RunningTurn {
    registry: CancellationRegistry,
    id: String,
    pub(super) flag: Arc<AtomicBool>,
}

impl Drop for RunningTurn {
    fn drop(&mut self) {
        let mut running = self.registry.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        running.remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_ids_cannot_replace_cancellation_and_drop_unregisters() {
        let registry = CancellationRegistry::default();
        let running = registry.register("turn").unwrap();
        assert!(registry.register("turn").is_err());
        assert!(registry.cancel("turn"));
        assert!(running.flag.load(Ordering::Acquire));
        drop(running);
        assert!(!registry.cancel("turn"));
        assert!(registry.register("turn").is_ok());
    }
}
