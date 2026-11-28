#![forbid(unsafe_code)]
//! The Rust SDK of Doric bundles (spec `docs/designs/grpc-processes.md`,
//! section 10, "The Rust SDK"): the bundle side of the control stream of
//! section 5, server side only. A bundle built on it serves the methods it
//! registers in [`Services`] and calls no other bundle: there is no client of
//! the router, no registration, no replay, no `log/v1` facade, no asset and no
//! HTTP prefix.
//!
//! The SDK does not check protovalidate rules (section 10, "No
//! protovalidate"): a handler checks its own rules. A request that does not
//! decode ends the call `invalid_input`.
//!
//! ```no_run
//! use std::process::ExitCode;
//!
//! use doric_bundle::{Bundle, ContractError, Services};
//!
//! struct Kv;
//!
//! impl Bundle for Kv {
//!     fn services(&self) -> Services {
//!         Services::new()
//!     }
//!
//!     async fn activate(&self) -> Result<(), ContractError> {
//!         Ok(())
//!     }
//!
//!     async fn stop(&self) {}
//! }
//!
//! fn main() -> ExitCode {
//!     doric_bundle::run(Kv)
//! }
//! ```

use std::{
    collections::HashMap,
    future::Future,
    marker::PhantomData,
    pin::Pin,
    process::ExitCode,
    task::{Context, Poll},
    time::SystemTime,
};

pub use tokio_stream::Stream;
pub use tokio_util::sync::CancellationToken;

mod calls;
mod codes;
mod credit;
mod frames;

/// The generated messages and client of `doric.platform.v1` and `google.rpc`,
/// nested by package so their references to each other resolve.
#[allow(dead_code, clippy::all)]
mod proto {
    pub mod doric {
        pub mod platform {
            pub mod v1 {
                tonic::include_proto!("doric.platform.v1");
            }
        }
    }

    pub mod google {
        pub mod rpc {
            tonic::include_proto!("google.rpc");
        }
    }
}

/// Runs a bundle process until the host stops it, and answers the exit code
/// `main` returns.
///
/// It reads the instance from the environment the supervisor sets (section 7,
/// "Spawn"): `DORIC_ROUTER_URL`, `DORIC_INSTANCE_TOKEN`, `DORIC_BUNDLE_ID`,
/// `DORIC_GENERATION` and `DORIC_INCARNATION`; the token stays in the
/// environment. It opens `doric.platform.v1.BundleHostService/Connect` on the
/// router URL over cleartext HTTP/2 with `authorization: Bearer <token>`, and
/// sends `Hello { protocol_version: 1, instance, services, http_port: 0 }`,
/// where `services` are the service names of the paths of
/// [`Bundle::services`]. Then it answers the host's frames:
///
/// - `Activate` runs [`Bundle::activate`] and answers `ActivateResult` with
///   code 0, or the status of the [`ContractError`].
/// - `HealthCheck` answers `HealthReply` with the frame's nonce without
///   running bundle code. The reader answers it between frames, so a handler
///   that blocks before its first `.await` delays it and can fail the health
///   check: run blocking work with `tokio::task::spawn_blocking`.
/// - `GenerationChanged` answers `GenerationAck`; calls in flight keep
///   running.
/// - `CallStart` runs the handler of its method on its own task, with the
///   credit flow of section 5 (see [`Services`]).
/// - `PeerSignal`, `InstanceGone` and `ProviderChanged` are ignored.
/// - `Stop` cancels nothing in flight, waits for the handlers within the stop
///   deadline the host enforces, runs [`Bundle::stop`], answers `StopResult`
///   and returns exit code 0.
///
/// Logs are JSON lines on stdout with `level`, `msg` and the instance.
///
/// # Errors
///
/// It never panics on a protocol or environment failure; it returns exit code
/// 70 (the host is gone, section 7) when the environment is missing or
/// malformed, when the connection fails, when the host answers `Rejected`
/// (whose reason it logs), when the control stream ends after `Accepted`, or
/// when no answer to the `Hello` arrives within the Hello timeout of
/// 10 seconds, the platform's own.
pub fn run<B: Bundle>(bundle: B) -> ExitCode {
    frames::run(bundle)
}

/// The level of a log line, written as its lowercase name in the line's
/// `level` field: `debug`, `info`, `warn` or `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Detail for diagnosis.
    Debug,
    /// A step of the bundle's life, such as an open store.
    Info,
    /// A failure the bundle recovers from.
    Warn,
    /// A failure the bundle does not recover from.
    Error,
}

/// Writes one log line on stdout, the same JSON line the SDK writes for its
/// own events: `level`, `msg` = `message`, and the instance's `bundleId`,
/// `generation` and `incarnation`, which the supervisor merges into the host's
/// log (section 15).
///
/// A line written before [`run`] has read the environment, or when the
/// environment is malformed, has no instance fields. It never fails and may be
/// called from any thread.
pub fn log(level: Level, message: &str) {
    frames::log(level, message);
}

impl Level {
    /// The lowercase name the line's `level` field holds.
    fn name(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// A bundle the SDK runs: the methods it serves and its lifecycle hooks.
///
/// The SDK holds the bundle for the life of the process and calls its hooks
/// from any task, so it is `Send + Sync + 'static`.
pub trait Bundle: Send + Sync + 'static {
    /// The methods the bundle serves. Called once, before the `Hello`, whose
    /// `services` it determines; a method absent from it answers
    /// `UNIMPLEMENTED`.
    fn services(&self) -> Services;

    /// Activates the bundle when the host sends `Activate`, after `Accepted`.
    ///
    /// # Errors
    ///
    /// A [`ContractError`] fails the activation: the SDK answers
    /// `ActivateResult` with its status, built as for a call (see
    /// [`ContractError`]), and the host decides what follows.
    fn activate(&self) -> impl Future<Output = Result<(), ContractError>> + Send;

    /// Deactivates the bundle when the host sends `Stop`, after the handlers in
    /// flight have finished or the host's stop deadline has passed. The process
    /// exits with code 0 once it returns.
    fn stop(&self) -> impl Future<Output = ()> + Send;
}

/// The methods a bundle serves, each by its path and handler; built by
/// chaining the registration methods from [`Services::new`].
///
/// A path is the gRPC method path, `"/doric.storage.kv.v1.KvService/Get"`; its
/// service name, the part between the slashes, goes in the `Hello`. Each
/// handler runs on its own task and receives the [`Call`] first. For every
/// kind of call the SDK:
///
/// - decodes each request message as `Req` and encodes each response as
///   `Res`;
/// - sends at most the `CallStart`'s `initial_credit` response messages, then
///   one more per message counted in a `CallCredit` from the host, so it never
///   sends a message beyond credit;
/// - ends the call with `CallEnd`: `OK` after the last response, the status of
///   a [`ContractError`], `limit_exceeded` instead of sending a response whose
///   frame would pass 4 MiB, `internal` when the handler panics, and
///   `CANCELLED` once [`Call::cancelled`] is cancelled, whatever the handler
///   returns after.
#[derive(Default)]
pub struct Services {
    methods: calls::Methods,
}

impl Services {
    /// An empty set: every method answers `UNIMPLEMENTED`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a unary method: `handler` receives the one request message
    /// and its answer is the one response message, or the error that ends the
    /// call.
    pub fn unary<Req, Res, F, Fut>(mut self, path: &'static str, handler: F) -> Self
    where
        Req: prost::Message + Default + Send + 'static,
        Res: prost::Message + Default + Send + 'static,
        F: Fn(Call, Req) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Res, ContractError>> + Send + 'static,
    {
        self.methods.unary(path, handler);
        self
    }

    /// Registers a server-streaming method: `handler` receives the one request
    /// message and answers a stream of response messages. The SDK takes the
    /// next item only when it has credit to send it; the first `Err` item ends
    /// the call with its status, and the end of the stream ends it `OK`.
    pub fn server_stream<Req, Res, F, S>(mut self, path: &'static str, handler: F) -> Self
    where
        Req: prost::Message + Default + Send + 'static,
        Res: prost::Message + Default + Send + 'static,
        F: Fn(Call, Req) -> S + Send + Sync + 'static,
        S: Stream<Item = Result<Res, ContractError>> + Send + 'static,
    {
        self.methods.server_stream(path, handler);
        self
    }

    /// Registers a client-streaming method: `handler` receives the request
    /// messages as [`Requests`] and answers the one response message, or the
    /// error that ends the call, which it may answer before it has read every
    /// request.
    pub fn client_stream<Req, Res, F, Fut>(mut self, path: &'static str, handler: F) -> Self
    where
        Req: prost::Message + Default + Send + 'static,
        Res: prost::Message + Default + Send + 'static,
        F: Fn(Call, Requests<Req>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Res, ContractError>> + Send + 'static,
    {
        self.methods.client_stream(path, handler);
        self
    }
}

/// The request messages of a client-streaming call, in the order the caller
/// sent them.
///
/// Each item the handler takes grants the host one more request message
/// (`CallCredit { messages: 1 }`), so the host never sends more than the
/// handler has room for. The stream ends after the caller half-closes and the
/// last message is taken; an `Err` item is the last item. Once
/// [`Call::cancelled`] is cancelled the stream ends.
pub struct Requests<Req> {
    inbox: calls::Inbox,
    _messages: PhantomData<fn() -> Req>,
}

impl<Req: prost::Message + Default> Stream for Requests<Req> {
    type Item = Result<Req, ContractError>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inbox.poll_next(context).map(|payload| {
            payload.map(|payload| {
                let request = calls::decode(&payload);

                if request.is_err() {
                    self.inbox.close();
                }

                request
            })
        })
    }
}

/// The bundle instance that made a call, as the router checked it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    /// The calling bundle's id; `"doric"` for a call through the gateway.
    pub bundle_id: String,
    /// The calling bundle's version.
    pub version: String,
    /// The generation of the calling instance.
    pub generation: u32,
    /// The incarnation of the calling instance within its generation.
    pub incarnation: u32,
}

/// What a handler knows of the call it serves, from the call's `CallStart`.
#[derive(Debug, Clone)]
pub struct Call {
    /// Who made the call.
    pub caller: Caller,
    /// The call's scope entries, such as `windowKey`; empty when it has none.
    pub scope: HashMap<String, String>,
    /// The W3C `traceparent` of the call; empty when it has none.
    pub traceparent: String,
    /// When the call times out; `None` when it has no deadline.
    pub deadline: Option<SystemTime>,
    /// Cancelled when the host sends `CallCancel` or the deadline passes; the
    /// call then ends `CANCELLED` whatever the handler answers. A handler that
    /// runs long should watch it.
    pub cancelled: CancellationToken,
}

/// An error a handler or [`Bundle::activate`] answers, by its Doric code.
///
/// The SDK sends it as a `google.rpc.Status` (section 3, "Errors"): the gRPC
/// code that the error table of `packages/bundle/src/contracts/status.ts`
/// gives `code`, `FAILED_PRECONDITION` for a code the table does not hold;
/// `message`; and the details `google.rpc.ErrorInfo { reason: code, domain:
/// "doric" }` and `doric.platform.v1.ErrorDetails` with `details`. The caller
/// receives the same code, message and details.
#[derive(Debug, Clone, PartialEq)]
pub struct ContractError {
    /// The Doric error code, such as `"not_found"` or `"invalid_input"`.
    pub code: String,
    /// The message for the caller.
    pub message: String,
    /// Structured details for the caller; `None` when there are none.
    pub details: Option<prost_types::Struct>,
}

impl ContractError {
    /// An error of `code` with `message` and no details.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ContractError {}
