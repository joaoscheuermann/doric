//! The [`Engine`]'s streamed reads: `storage/v2`'s `Get`, `Query`, `Read` and
//! `GetBlob` each run one read transaction in a spawned task.

use std::{ops::ControlFlow, sync::Arc};

use doric_bundle::{Call, ContractError};
use doric_storage::{
    query,
    v2::{QueryRequest, QueryResponse},
};
use tokio_stream::wrappers::ReceiverStream;

use crate::{Engine, kv};

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

    /// Serves `storage/v2`'s `Query`: [`doric_storage::bundle`],
    /// [`query::check`] and [`Engine::store`], then, in a spawned task,
    /// [`query::page`] in one read transaction, whose items it streams.
    ///
    /// # Errors
    ///
    /// The stream's one item is the first refusal of the three, and no
    /// connection is touched; otherwise its last item is the error of the
    /// read, after the items already emitted.
    pub(super) fn query_documents(
        &self,
        call: Call,
        request: QueryRequest,
    ) -> ReceiverStream<Result<QueryResponse, ContractError>> {
        let checked = doric_storage::bundle(&call.caller).and_then(|bundle| {
            let plan = query::check(bundle, &request)?;
            self.store()?;
            Ok((bundle.to_owned(), plan))
        });
        let (bundle, plan) = match checked {
            Ok(checked) => checked,
            Err(error) => return kv::refused(error),
        };
        self.stream_read(move |txn, emit| query::page(txn, &bundle, &plan, emit))
    }
}
