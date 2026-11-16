//! Optional, task-scoped presentation output. Never part of a build request/signature.
use serde::Serialize;
use std::{collections::BTreeMap, future::Future, sync::{Arc, Mutex}};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedResourceIdentity {
    pub fqbn: String,
    pub options: BTreeMap<String, String>,
    pub mcu: String,
    pub variant: String,
    pub core_version: String,
    pub f_cpu: String,
}

pub(crate) type ObservationSlot = Arc<Mutex<Option<ResolvedResourceIdentity>>>;
tokio::task_local! { static OBSERVATION: ObservationSlot; }

pub(crate) fn observe(identity: Option<ResolvedResourceIdentity>) {
    let _ = OBSERVATION.try_with(|slot| {
        if let Ok(mut value) = slot.lock() { *value = identity; }
    });
}

pub(crate) fn current() -> Option<ObservationSlot> { OBSERVATION.try_with(Arc::clone).ok() }

/// Carry the optional observation across the existing dedicated compile worker.
pub(crate) async fn with_observer<F: Future>(slot: Option<ObservationSlot>, future: F) -> F::Output {
    match slot { Some(slot) => OBSERVATION.scope(slot, future).await, None => future.await }
}

/// Scope an existing production future; does not run a second resolver.
pub async fn capture<F: Future>(future: F) -> (F::Output, Option<ResolvedResourceIdentity>) {
    let slot = Arc::new(Mutex::new(None));
    let result = OBSERVATION.scope(Arc::clone(&slot), future).await;
    let identity = slot.lock().ok().and_then(|value| value.clone());
    (result, identity)
}
