//! The handlers of `storage.kv/v1`: each refuses any caller but `doric`
//! ([`platform_only`]), then checks the request ([`limits`]), before it touches
//! a connection.

use doric_bundle::{Call, ContractError, Requests};
use doric_sqlite::{
    DORIC,
    kv::{CommitRequest, CommitResponse, GetRequest, GetResponse, RangeRequest, RangeResponse},
    limits::{self, Batch},
};
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

use crate::Engine;

impl Engine {
    /// Serves `Get`: one item per requested key, in request order, all from
    /// one committed state.
    ///
    /// # Errors
    ///
    /// The stream's one item is the error, and no connection is touched, when
    /// [`platform_only`] refuses the caller or [`limits::get`] refuses the
    /// request for `call.caller.bundle_id`. Before a successful activation it
    /// is `unavailable`. Otherwise the errors of
    /// [`doric_sqlite::SqliteEngine::get`].
    pub(crate) fn get(
        &self,
        call: Call,
        request: GetRequest,
    ) -> ReceiverStream<Result<GetResponse, ContractError>> {
        match platform_only(&call)
            .and_then(|()| limits::get(&call.caller.bundle_id, &request))
            .and_then(|()| self.store())
        {
            Ok(store) => store.get(request.keys),
            Err(error) => refused(error),
        }
    }

    /// Serves `Range`: the entries of `[start, end)` in key order, or reverse
    /// order, at most `limit`, all from one committed state.
    ///
    /// # Errors
    ///
    /// The stream's one item is the error, and no connection is touched, when
    /// [`platform_only`] refuses the caller or [`limits::range`] refuses the
    /// request for `call.caller.bundle_id`. Before a successful activation it
    /// is `unavailable`. Otherwise the errors of
    /// [`doric_sqlite::SqliteEngine::range`].
    pub(crate) fn range(
        &self,
        call: Call,
        request: RangeRequest,
    ) -> ReceiverStream<Result<RangeResponse, ContractError>> {
        match platform_only(&call)
            .and_then(|()| limits::range(&call.caller.bundle_id, &request))
            .and_then(|()| self.store())
        {
            Ok(store) => store.range(request),
            Err(error) => refused(error),
        }
    }

    /// Serves `Commit`: takes the items into a [`limits::Batch`] as they
    /// arrive, then, once the stream ends, commits them all or none and answers
    /// the commit's position.
    ///
    /// # Errors
    ///
    /// A refusal of [`platform_only`] answers at once, before any item is read.
    /// The first refusal of [`limits::Batch::push`] answers at once, before the
    /// stream ends, and nothing is written; so does an `Err` item of
    /// `requests`. Then the refusal of [`limits::Batch::finish`], `unavailable`
    /// before a successful activation, and the errors of
    /// [`doric_sqlite::SqliteEngine::commit`]. A cancelled call writes nothing
    /// unless the writer has already begun its transaction.
    pub(crate) async fn commit(
        &self,
        call: Call,
        mut requests: Requests<CommitRequest>,
    ) -> Result<CommitResponse, ContractError> {
        platform_only(&call)?;
        let mut batch = Batch::default();
        while let Some(request) = requests.next().await {
            let request = request?;
            batch.push(&call.caller.bundle_id, request)?;
        }
        // A cancelled call ends its stream early: what arrived is not the
        // whole commit.
        if call.cancelled.is_cancelled() {
            return Err(cancelled());
        }
        let items = batch.finish()?;
        let store = self.store()?;

        tokio::select! {
            biased;
            () = call.cancelled.cancelled() => Err(cancelled()),
            position = store.commit(items) => Ok(CommitResponse { position: position? }),
        }
    }
}

/// `not_owner`, message `storage.kv/v1 serves only the platform.`, no details,
/// unless `call.caller.bundle_id` is `doric`.
fn platform_only(call: &Call) -> Result<(), ContractError> {
    if call.caller.bundle_id == DORIC {
        Ok(())
    } else {
        Err(ContractError::new(
            "not_owner",
            "storage.kv/v1 serves only the platform.",
        ))
    }
}

/// A stream whose one item is `error`.
pub(crate) fn refused<T>(error: ContractError) -> ReceiverStream<Result<T, ContractError>> {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    // The channel has room for the one item and its receiver is alive.
    let _ = sender.try_send(Err(error));
    ReceiverStream::new(receiver)
}

/// The error of a cancelled call; the SDK ends the call `CANCELLED` anyway.
pub(crate) fn cancelled() -> ContractError {
    ContractError::new("cancelled", "The call was cancelled.")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use doric_bundle::{Caller, CancellationToken};
    use tokio_stream::Stream;

    use super::*;

    const MESSAGE: &str = "storage.kv/v1 serves only the platform.";

    fn call_from(bundle_id: &str) -> Call {
        Call {
            caller: Caller {
                bundle_id: bundle_id.to_owned(),
                version: "1.0.0".to_owned(),
                generation: 1,
                incarnation: 1,
            },
            scope: HashMap::new(),
            traceparent: String::new(),
            deadline: None,
            cancelled: CancellationToken::new(),
        }
    }

    /// The one item of `stream`, which must then end.
    async fn only<T: std::fmt::Debug>(
        stream: impl Stream<Item = Result<T, ContractError>>,
    ) -> Result<T, ContractError> {
        let items: Vec<_> = stream.collect().await;
        let [item] = <[_; 1]>::try_from(items).expect("one item");
        item
    }

    fn get_of(count: usize) -> GetRequest {
        GetRequest {
            keys: (0..count).map(|n| format!("a/{n}").into_bytes()).collect(),
        }
    }

    #[test]
    fn only_the_platform_is_served() {
        assert_eq!(
            platform_only(&call_from("a")),
            Err(ContractError::new("not_owner", MESSAGE))
        );
        assert_eq!(platform_only(&call_from("doric")), Ok(()));
    }

    #[tokio::test]
    async fn another_caller_is_not_owner_before_any_limit_or_the_store() {
        let engine = Engine::default();

        for item in [
            only(engine.get(call_from("a"), get_of(0)))
                .await
                .map(|_| ()),
            only(engine.get(call_from("a"), get_of(1001)))
                .await
                .map(|_| ()),
            only(engine.range(
                call_from("a"),
                RangeRequest {
                    start: b"a/".to_vec(),
                    end: b"a0".to_vec(),
                    limit: 0,
                    ..RangeRequest::default()
                },
            ))
            .await
            .map(|_| ()),
        ] {
            assert_eq!(item, Err(ContractError::new("not_owner", MESSAGE)));
        }
    }

    #[tokio::test]
    async fn the_platform_reaches_the_store_which_is_unavailable_before_activation() {
        let engine = Engine::default();

        let item = only(engine.get(call_from("doric"), get_of(1))).await;

        assert_eq!(item.expect_err("the store is not open").code, "unavailable");
    }
}
