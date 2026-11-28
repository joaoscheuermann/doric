//! The [`Engine`]'s `storage/v2` `Watch`: the live changes of the caller's
//! own types and streams, which each commit publishes once it has committed.

use std::pin::Pin;

use doric_bundle::{Call, ContractError};
use doric_storage::{
    v2::{WatchRequest, WatchResponse},
    watch,
};
use tokio_stream::Stream;

use crate::{Engine, kv};

/// The responses of one `Watch` call.
type Responses = Pin<Box<dyn Stream<Item = Result<WatchResponse, ContractError>> + Send>>;

impl Engine {
    /// Serves `storage/v2`'s `Watch`: [`doric_storage::bundle`],
    /// [`watch::check`] and [`Engine::store`], then the subscription of
    /// [`watch::Watchers::subscribe`], until the caller goes or the watcher
    /// falls behind.
    ///
    /// # Errors
    ///
    /// The stream's one item is the first refusal of the three; otherwise
    /// its last item is the `unavailable` of a watcher that fell behind.
    pub(super) fn watch(&self, call: Call, request: WatchRequest) -> Responses {
        let checked = doric_storage::bundle(&call.caller).and_then(|bundle| {
            watch::check(bundle, &request)?;
            self.store()?;
            Ok(bundle.to_owned())
        });
        match checked {
            Ok(bundle) => Box::pin(self.watchers.subscribe(&bundle, request)),
            Err(error) => Box::pin(kv::refused(error)),
        }
    }
}
