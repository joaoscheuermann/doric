//! `storage/v2.Watch` (spec "The storage contract", "Watch", A79; plan S78
//! Q3): the live changes of a bundle's own types and streams. The writer
//! publishes each commit's [`Change`] after its `COMMIT` succeeds; every
//! watcher of the commit's bundle whose request names a type or a stream the
//! change lists receives one `WatchResponse`, from the moment it subscribed.
//! There is no durable feed: nothing is kept for a watcher that is not
//! there.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use doric_bundle::ContractError;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio_stream::{Stream, wrappers::ReceiverStream};

use crate::v2::{WatchDocument, WatchRequest, WatchResponse, WatchStream};

/// The most responses one watcher holds unread; a publish that finds its
/// buffer full ends its stream with `unavailable`, message `Watch fell
/// behind.`.
pub const BUFFER: usize = 1_024;

/// The watchers of every bundle, shared by the `Watch` handlers, which
/// subscribe, and the writer, which publishes. Clones share one set.
#[derive(Clone, Default)]
pub struct Watchers {
    /// The subscribers of each bundle.
    subscribers: Arc<Mutex<HashMap<String, Vec<Subscriber>>>>,
}

/// One watcher: what it asked and where its responses go.
struct Subscriber {
    /// The watcher's request.
    request: WatchRequest,
    /// Where its responses go, at most [`BUFFER`] unread.
    sender: mpsc::Sender<WatchResponse>,
    /// Set once a publish found its buffer full.
    behind: Arc<AtomicBool>,
}

/// What one commit changed (Q3): every document a put named, with its new
/// revision and `deleted` false, and every document a delete named, with
/// revision 0 and `deleted` true; every stream a `drop_stream`, `truncate` or
/// `append` named, with its `lastSequence` after the commit (0 when dropped).
/// One entry per key, in its last state; an `expect` is not listed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    /// The commit's position.
    pub position: f64,
    /// The documents the commit put or deleted.
    pub documents: Vec<WatchDocument>,
    /// The streams the commit dropped, truncated or appended to.
    pub streams: Vec<WatchStream>,
}

/// Checks the `Watch` request `request` of the bundle `bundle` before any
/// subscription: each type with [`crate::schema::owned`], then each stream
/// with [`crate::streams::checked`]. An empty request is valid and receives
/// nothing.
///
/// # Errors
///
/// `not_owner` for the bundle `doric` ([`doric_sqlite::DORIC`]), which has
/// no prefix; the errors of `owned` for the first type that fails
/// (`invalid_input`, then `not_owner`, detail `type`); the errors of
/// `checked` for the first stream that fails (`invalid_input`, then
/// `invalid_stream`, then `not_owner`, detail `stream`).
pub fn check(bundle: &str, request: &WatchRequest) -> Result<(), ContractError> {
    if bundle == doric_sqlite::DORIC {
        return Err(ContractError::new(
            "not_owner",
            "storage/v2 has no prefix for the caller doric; it may call only Import, Inspect and Check.",
        ));
    }
    for type_id in &request.types {
        crate::schema::owned(type_id, bundle)?;
    }
    for stream in &request.streams {
        crate::streams::checked(bundle, stream)?;
    }
    Ok(())
}

impl Watchers {
    /// Subscribes a watcher of `bundle` for `request`, one [`check`]
    /// accepted. The stream yields one `WatchResponse` per later
    /// [`Watchers::publish`] of `bundle` whose change lists a type or a stream
    /// `request` names by exact id, holding the change's position and only
    /// those documents and streams, in publication order. Once a publish finds
    /// [`BUFFER`] responses unread, the stream yields the responses it holds,
    /// then `Err` `unavailable` with the message `Watch fell behind.`, then
    /// ends. Dropping the stream unsubscribes it; the next publish of its
    /// bundle removes it.
    pub fn subscribe(
        &self,
        bundle: &str,
        request: WatchRequest,
    ) -> impl Stream<Item = Result<WatchResponse, ContractError>> + Send + 'static {
        use tokio_stream::StreamExt as _;

        let (sender, receiver) = mpsc::channel(BUFFER);
        let behind = Arc::new(AtomicBool::new(false));
        self.lock()
            .entry(bundle.to_owned())
            .or_default()
            .push(Subscriber {
                request,
                sender,
                behind: Arc::clone(&behind),
            });
        // The receiver ends once the publisher drops the sender, after the
        // responses it holds; only then is `behind` read.
        ReceiverStream::new(receiver)
            .map(Ok)
            .chain(tokio_stream::once(()).filter_map(move |()| {
                behind
                    .load(Ordering::SeqCst)
                    .then(|| Err(ContractError::new("unavailable", "Watch fell behind.")))
            }))
    }

    /// Publishes `change`, a commit of `bundle`, to each of its watchers whose
    /// request it touches, without waiting: a watcher whose buffer is full is
    /// dropped and its stream ends `unavailable`. Called by the writer after
    /// `COMMIT`, never for a rolled-back transaction.
    pub fn publish(&self, bundle: &str, change: &Change) {
        let mut subscribers = self.lock();
        let Some(watchers) = subscribers.get_mut(bundle) else {
            return;
        };
        watchers.retain(|subscriber| {
            let Some(response) = subscriber.response(change) else {
                return !subscriber.sender.is_closed();
            };
            match subscriber.sender.try_send(response) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    subscriber.behind.store(true, Ordering::SeqCst);
                    false
                }
                Err(TrySendError::Closed(_)) => false,
            }
        });
        if watchers.is_empty() {
            subscribers.remove(bundle);
        }
    }

    /// The subscribers, whose lock no holder panics under.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Subscriber>>> {
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Subscriber {
    /// The entries of `change` this watcher's request names, at the change's
    /// position; `None` when it names none of them.
    fn response(&self, change: &Change) -> Option<WatchResponse> {
        let documents: Vec<WatchDocument> = change
            .documents
            .iter()
            .filter(|document| self.request.types.contains(&document.r#type))
            .cloned()
            .collect();
        let streams: Vec<WatchStream> = change
            .streams
            .iter()
            .filter(|stream| self.request.streams.contains(&stream.stream))
            .cloned()
            .collect();
        (!documents.is_empty() || !streams.is_empty()).then_some(WatchResponse {
            position: change.position,
            documents,
            streams,
        })
    }
}

#[cfg(test)]
mod tests;
