//! The [`Engine`]'s streamed reads: `storage/v2`'s `Get`, `Query`, `Read` and
//! `GetBlob` each run one read transaction in a spawned task.

use std::{ops::ControlFlow, sync::Arc};

use doric_bundle::ContractError;
use tokio_stream::wrappers::ReceiverStream;

use crate::Engine;

/// The most items a `storage/v2` `Get` or `Query` holds before its reader
/// waits for the caller.
const ANSWERS: usize = 16;

impl Engine {
    /// Runs `work` in one read transaction in a spawned task and streams the
    /// items it emits; a gone caller breaks `work`, and the read's error, if
    /// any, is the stream's last item.
    pub(super) fn stream_read<R: Send + 'static>(
        &self,
        work: impl FnOnce(
            &mut dyn doric_sqlite::ReadTxn,
            &mut dyn FnMut(R) -> ControlFlow<()>,
        ) -> Result<(), ContractError>
        + Send
        + 'static,
    ) -> ReceiverStream<Result<R, ContractError>> {
        let (answers, stream) = tokio::sync::mpsc::channel(ANSWERS);
        let store = Arc::clone(&self.store);
        tokio::spawn(async move {
            let Some(store) = store.get() else { return };
            let emitter = answers.clone();
            let read = doric_sqlite::KvEngine::read(store, move |txn| {
                work(
                    txn,
                    &mut |response| match emitter.blocking_send(Ok(response)) {
                        Ok(()) => ControlFlow::Continue(()),
                        Err(_) => ControlFlow::Break(()),
                    },
                )
            });
            if let Err(error) = read.await {
                // A caller that is gone takes no error.
                let _ = answers.send(Err(error)).await;
            }
        });
        ReceiverStream::new(stream)
    }
}
