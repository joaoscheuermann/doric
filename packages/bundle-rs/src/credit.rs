//! The response credit of a call (spec section 5, "Flow control"): the SDK
//! sends at most `initial_credit` response messages, then one more per
//! message a `CallCredit` from the host counts.

use std::sync::Arc;

use tokio::sync::{Semaphore, SemaphorePermit};
use tokio_util::sync::CancellationToken;

/// The response messages a call may still send; clones share the count.
#[derive(Clone)]
pub(crate) struct Credit(Arc<Semaphore>);

impl Credit {
    pub(crate) fn new(initial: u32) -> Self {
        Self(Arc::new(Semaphore::new(initial as usize)))
    }

    /// Adds the messages a `CallCredit` counts.
    pub(crate) fn grant(&self, messages: u32) {
        self.0.add_permits(messages as usize);
    }

    /// Waits for one message of credit; `None` once `cancelled` is cancelled.
    /// The permit spends the credit when it is forgotten and gives it back
    /// when it is dropped.
    pub(crate) async fn reserve(
        &self,
        cancelled: &CancellationToken,
    ) -> Option<SemaphorePermit<'_>> {
        tokio::select! {
            biased;
            () = cancelled.cancelled() => None,
            permit = self.0.acquire() => permit.ok(),
        }
    }
}
