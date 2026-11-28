//! Host-to-bundle calls (spec section 5, "Host-to-bundle calls" and "Flow
//! control"): the registered handlers, and the calls in flight on the control
//! stream, each on its own task, which ends with one `CallEnd`.

use std::{
    collections::{BTreeSet, HashMap},
    future::Future,
    marker::PhantomData,
    pin::{Pin, pin},
    sync::{Arc, Mutex, PoisonError},
    task::{Context, Poll, ready},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::sync::{Notify, SemaphorePermit, mpsc, oneshot};
use tokio_stream::{Stream, StreamExt};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use crate::{
    Call, Caller, ContractError, Requests, codes,
    credit::Credit,
    frames::Outbound,
    proto::doric::platform::v1::{
        CallCredit, CallEnd, CallMessage, CallStart, ConnectRequest, connect_request::Frame,
    },
};

/// The largest encoded `ConnectRequest` frame carrying a response the SDK
/// sends, as `maxMessageBytes` of `packages/bundle/src/contracts/metadata.ts`.
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// How a handler ends: `Ok` once its responses are sent.
type Outcome = Result<(), ContractError>;

/// A registered method, type-erased: it runs one call to its outcome.
type Handler = Arc<dyn Fn(Exchange) -> Pin<Box<dyn Future<Output = Outcome> + Send>> + Send + Sync>;

/// What a handler receives of its call.
struct Exchange {
    call: Call,
    /// The `CallStart`'s payload, for unary and server-streaming methods.
    payload: Vec<u8>,
    /// The request messages, for client-streaming methods.
    inbox: Inbox,
    responses: Responder,
}

/// The registered methods, by path.
#[derive(Default)]
pub(crate) struct Methods(HashMap<&'static str, Handler>);

impl Methods {
    pub(crate) fn unary<Req, Res, F, Fut>(&mut self, path: &'static str, handler: F)
    where
        Req: prost::Message + Default + Send + 'static,
        Res: prost::Message + Default + Send + 'static,
        F: Fn(Call, Req) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Res, ContractError>> + Send + 'static,
    {
        self.register(path, move |exchange| {
            let answer = decode(&exchange.payload).map(|request| handler(exchange.call, request));
            let responses = exchange.responses;

            async move { responses.answer(answer?.await?).await }
        });
    }

    pub(crate) fn server_stream<Req, Res, F, S>(&mut self, path: &'static str, handler: F)
    where
        Req: prost::Message + Default + Send + 'static,
        Res: prost::Message + Default + Send + 'static,
        F: Fn(Call, Req) -> S + Send + Sync + 'static,
        S: Stream<Item = Result<Res, ContractError>> + Send + 'static,
    {
        self.register(path, move |exchange| {
            let stream = decode(&exchange.payload).map(|request| handler(exchange.call, request));
            let responses = exchange.responses;

            async move {
                let mut stream = pin!(stream?);

                loop {
                    let permit = responses.reserve().await?;

                    match stream.next().await {
                        Some(response) => responses.send(permit, &response?)?,
                        None => return Ok(()),
                    }
                }
            }
        });
    }

    pub(crate) fn client_stream<Req, Res, F, Fut>(&mut self, path: &'static str, handler: F)
    where
        Req: prost::Message + Default + Send + 'static,
        Res: prost::Message + Default + Send + 'static,
        F: Fn(Call, Requests<Req>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Res, ContractError>> + Send + 'static,
    {
        self.register(path, move |exchange| {
            let requests = Requests {
                inbox: exchange.inbox,
                _messages: PhantomData,
            };
            let answer = handler(exchange.call, requests);
            let responses = exchange.responses;

            async move { responses.answer(answer.await?).await }
        });
    }

    fn register<F, Fut>(&mut self, path: &'static str, run: F)
    where
        F: Fn(Exchange) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Outcome> + Send + 'static,
    {
        self.0
            .insert(path, Arc::new(move |exchange| Box::pin(run(exchange))));
    }

    /// The service names of the registered paths, for the `Hello`.
    pub(crate) fn services(&self) -> Vec<String> {
        self.0
            .keys()
            .filter_map(|path| path.split('/').nth(1))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(str::to_owned)
            .collect()
    }
}

/// The request a payload carries; `invalid_input` when it does not decode.
pub(crate) fn decode<M: prost::Message + Default>(payload: &[u8]) -> Result<M, ContractError> {
    M::decode(payload).map_err(|error| {
        ContractError::new(
            "invalid_input",
            format!("The request does not decode: {error}."),
        )
    })
}

/// The `deadline_unix_ms` of a `CallStart` as a time, in whole
/// milliseconds; 0 (or a value that is no time) is none.
fn deadline(unix_ms: f64) -> Option<SystemTime> {
    (unix_ms.is_finite() && unix_ms >= 1.0)
        .then(|| UNIX_EPOCH.checked_add(Duration::from_millis(unix_ms as u64)))
        .flatten()
}

/// The request messages of one call, as a client-streaming handler takes
/// them: each one taken grants the host one more with `CallCredit`.
pub(crate) struct Inbox {
    payloads: mpsc::UnboundedReceiver<Vec<u8>>,
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    call_id: u64,
    out: Outbound,
    open: bool,
}

impl Inbox {
    /// The next request payload; `None` after the half-close, once the call
    /// is cancelled, or once [`Inbox::close`] was called.
    pub(crate) fn poll_next(&mut self, context: &mut Context<'_>) -> Poll<Option<Vec<u8>>> {
        if !self.open || self.cancelled.as_mut().poll(context).is_ready() {
            self.open = false;
            return Poll::Ready(None);
        }

        let payload = ready!(self.payloads.poll_recv(context));

        match &payload {
            Some(_) => self.out.send(Frame::CallCredit(CallCredit {
                call_id: self.call_id,
                messages: 1,
            })),
            None => self.open = false,
        }

        Poll::Ready(payload)
    }

    /// Ends the messages: the next poll answers `None`.
    pub(crate) fn close(&mut self) {
        self.open = false;
    }
}

/// Sends the response messages of one call within its credit.
struct Responder {
    call_id: u64,
    out: Outbound,
    credit: Credit,
    cancelled: CancellationToken,
}

impl Responder {
    /// Sends the one response of a unary or client-streaming call.
    async fn answer(&self, response: impl prost::Message) -> Outcome {
        let permit = self.reserve().await?;
        self.send(permit, &response)
    }

    /// Waits for one message of credit; fails once the call is cancelled.
    async fn reserve(&self) -> Result<SemaphorePermit<'_>, ContractError> {
        self.credit
            .reserve(&self.cancelled)
            .await
            .ok_or_else(|| ContractError::new("cancelled", "The call was cancelled."))
    }

    /// Spends `permit` on one response message; `limit_exceeded` instead of a
    /// response whose encoded frame would pass 4 MiB.
    fn send(&self, permit: SemaphorePermit<'_>, response: &impl prost::Message) -> Outcome {
        let payload = response.encode_to_vec();
        let frame = ConnectRequest {
            frame: Some(Frame::CallMessage(CallMessage {
                call_id: self.call_id,
                payload,
            })),
        };

        if prost::Message::encoded_len(&frame) > MAX_MESSAGE_BYTES {
            return Err(ContractError::new(
                "limit_exceeded",
                format!("A response exceeds {MAX_MESSAGE_BYTES} bytes."),
            ));
        }

        if self.cancelled.is_cancelled() {
            return Err(ContractError::new("cancelled", "The call was cancelled."));
        }

        permit.forget();
        if let Some(frame) = frame.frame {
            self.out.send(frame);
        }
        Ok(())
    }
}

/// What the control stream keeps of one call in flight.
struct Open {
    cancelled: CancellationToken,
    credit: Credit,
    /// Dropped at the half-close, which ends the request messages.
    payloads: Option<mpsc::UnboundedSender<Vec<u8>>>,
}

/// The calls in flight on the control stream; clones share them.
#[derive(Clone)]
pub(crate) struct Calls {
    methods: Arc<Methods>,
    out: Outbound,
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    open: Mutex<HashMap<u64, Open>>,
    /// Notified each time a call ends.
    ended: Notify,
}

impl Calls {
    pub(crate) fn new(methods: Arc<Methods>, out: Outbound) -> Self {
        Self {
            methods,
            out,
            shared: Arc::default(),
        }
    }

    /// Runs the call on its own task, which sends its `CallEnd`. Resolves
    /// once the handler has run to its first wait, as the TypeScript SDK runs
    /// a handler before it reads the next frame: a frame after a `CallStart`
    /// is handled after the handler started.
    pub(crate) async fn start(&self, start: CallStart) {
        let cancelled = CancellationToken::new();
        let credit = Credit::new(start.initial_credit);
        let (payloads, inbox) = mpsc::unbounded_channel();
        let caller = start.caller.unwrap_or_default();
        let call = Call {
            caller: Caller {
                bundle_id: caller.bundle_id,
                version: caller.version,
                generation: caller.generation,
                incarnation: caller.incarnation,
            },
            scope: start.scope,
            traceparent: start.traceparent,
            deadline: deadline(start.deadline_unix_ms),
            cancelled: cancelled.clone(),
        };
        let exchange = Exchange {
            call,
            payload: start.payload,
            inbox: Inbox {
                payloads: inbox,
                cancelled: Box::pin(cancelled.clone().cancelled_owned()),
                call_id: start.call_id,
                out: self.out.clone(),
                open: true,
            },
            responses: Responder {
                call_id: start.call_id,
                out: self.out.clone(),
                credit: credit.clone(),
                cancelled: cancelled.clone(),
            },
        };

        self.lock().insert(
            start.call_id,
            Open {
                cancelled: cancelled.clone(),
                credit,
                payloads: Some(payloads),
            },
        );

        let handler = self.methods.0.get(start.method.as_str()).cloned();
        let calls = self.clone();
        let (started, running) = oneshot::channel();

        tokio::spawn(async move {
            let status = calls
                .serve(handler, &start.method, exchange, &cancelled, started)
                .await;

            calls.out.send(Frame::CallEnd(CallEnd {
                call_id: start.call_id,
                status: Some(status),
            }));
            calls.lock().remove(&start.call_id);
            calls.shared.ended.notify_waiters();
        });

        // Dropped unsent when no handler runs or its first poll panics.
        let _ = running.await;
    }

    /// Runs the handler to its end and answers the call's status.
    async fn serve(
        &self,
        handler: Option<Handler>,
        method: &str,
        exchange: Exchange,
        cancelled: &CancellationToken,
        started: oneshot::Sender<()>,
    ) -> crate::proto::google::rpc::Status {
        let Some(handler) = handler else {
            return codes::status(&ContractError::new(
                "unknown_contract",
                format!("This bundle does not serve {method}."),
            ));
        };
        let deadline = exchange.call.deadline;
        let mut work = tokio::spawn(FirstPoll {
            future: handler(exchange),
            started: Some(started),
        });
        let timer = async {
            match deadline {
                Some(deadline) => {
                    let left = deadline
                        .duration_since(SystemTime::now())
                        .unwrap_or_default();
                    tokio::time::sleep(left).await;
                }
                None => std::future::pending().await,
            }
        };
        let outcome = tokio::select! {
            outcome = &mut work => outcome,
            () = timer => {
                cancelled.cancel();
                work.await
            }
        };

        match outcome {
            _ if cancelled.is_cancelled() => codes::cancelled(),
            Ok(Ok(())) => codes::ok(),
            Ok(Err(error)) => codes::status(&error),
            Err(_) => codes::status(&ContractError::new(
                "internal",
                format!("The handler of {method} panicked."),
            )),
        }
    }

    /// A request message of a client-streaming call.
    pub(crate) fn message(&self, message: CallMessage) {
        if let Some(payloads) = self
            .lock()
            .get(&message.call_id)
            .and_then(|open| open.payloads.as_ref())
        {
            // A handler that returned has dropped its inbox; nothing reads it.
            let _ = payloads.send(message.payload);
        }
    }

    /// The caller sent its last request message.
    pub(crate) fn half_close(&self, call_id: u64) {
        if let Some(open) = self.lock().get_mut(&call_id) {
            open.payloads = None;
        }
    }

    /// The call is aborted; it still ends with `CallEnd`.
    pub(crate) fn cancel(&self, call_id: u64) {
        if let Some(open) = self.lock().get(&call_id) {
            open.cancelled.cancel();
        }
    }

    /// The host accepts more response messages.
    pub(crate) fn credit(&self, credit: CallCredit) {
        if let Some(open) = self.lock().get(&credit.call_id) {
            open.credit.grant(credit.messages);
        }
    }

    /// Resolves once no call is in flight.
    pub(crate) async fn idle(&self) {
        loop {
            let mut ended = pin!(self.shared.ended.notified());
            ended.as_mut().enable();

            if self.lock().is_empty() {
                return;
            }

            ended.await;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Open>> {
        self.shared
            .open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// A future that signals `started` once its first poll returned.
struct FirstPoll<F> {
    future: F,
    started: Option<oneshot::Sender<()>>,
}

impl<F: Future + Unpin> Future for FirstPoll<F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let poll = Pin::new(&mut self.future).poll(context);

        if let Some(started) = self.started.take() {
            let _ = started.send(());
        }

        poll
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_a_deadline_in_whole_milliseconds() {
        let ms = 1_764_000_000_123.0;

        let converted = deadline(ms).and_then(|at| at.duration_since(UNIX_EPOCH).ok());

        assert_eq!(
            converted.map(|since| since.as_millis()),
            Some(1_764_000_000_123)
        );
    }

    #[test]
    fn reads_zero_as_no_deadline() {
        assert_eq!(deadline(0.0), None);
        assert_eq!(deadline(f64::NAN), None);
    }
}
