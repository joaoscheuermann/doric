//! The bundle side of the control stream (spec section 5): the environment,
//! the `Hello`, the host's frames and the exit code; and the process's log
//! lines.

use std::{
    io::Write,
    pin::Pin,
    process::ExitCode,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    sync::{mpsc, oneshot},
    time::Instant,
};
use tokio_stream::Stream;
use tonic::{Streaming, metadata::AsciiMetadataValue, transport::Endpoint};

use crate::{
    Bundle, ContractError, Level,
    calls::Calls,
    codes,
    proto::doric::platform::v1::{
        ActivateResult, ConnectRequest, ConnectResponse, GenerationAck, HealthReply, Hello,
        Instance, StopResult, bundle_host_service_client::BundleHostServiceClient,
        connect_request::Frame, connect_response::Frame as HostFrame,
    },
};

/// How long the SDK waits for the answer to its `Hello`: the platform's Hello
/// timeout (`packages/bundle/src/platform/supervisor/timings.ts`).
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// How long, after `StopResult` left the queue, the SDK waits for the host to
/// end the stream before it exits, so the frame reaches the host.
const FLUSH_GRACE: Duration = Duration::from_millis(250);

/// The protocol version of the `Hello`.
const PROTOCOL_VERSION: u32 = 1;

/// The exit code of a process whose host is gone (section 7).
const HOST_GONE: u8 = 70;

/// Runs the bundle on a runtime of its own and answers its exit code.
pub(crate) fn run<B: Bundle>(bundle: B) -> ExitCode {
    let started = Instant::now();
    let log = Log::default();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => return log.gone(&format!("The runtime did not start: {error}.")),
    };
    let code = runtime.block_on(serve(bundle, started));

    // A handler that never returns must not hold the exit.
    runtime.shutdown_background();
    code
}

/// What the supervisor tells the process (section 7, "Spawn").
struct Environment {
    url: String,
    authorization: AsciiMetadataValue,
    instance: Instance,
}

impl Environment {
    fn read() -> Result<Self, String> {
        let token = variable("DORIC_INSTANCE_TOKEN")?;

        Ok(Self {
            url: variable("DORIC_ROUTER_URL")?,
            authorization: format!("Bearer {token}")
                .parse()
                .map_err(|_| "DORIC_INSTANCE_TOKEN is not a header value.".to_owned())?,
            instance: Instance {
                bundle_id: variable("DORIC_BUNDLE_ID")?,
                generation: number("DORIC_GENERATION")?,
                incarnation: number("DORIC_INCARNATION")?,
            },
        })
    }
}

fn variable(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is missing."))
}

fn number(name: &str) -> Result<u32, String> {
    variable(name)?
        .parse()
        .map_err(|_| format!("{name} is not a 32-bit unsigned integer."))
}

/// Connects, says `Hello` and answers the host's frames until `Stop` or the
/// host is gone.
async fn serve<B: Bundle>(bundle: B, started: Instant) -> ExitCode {
    let environment = match Environment::read() {
        Ok(environment) => environment,
        Err(message) => return Log::default().gone(&message),
    };
    let log = Log::new(&environment.instance);
    // Only `serve` sets it, once per process.
    let _ = CONTEXT.set(log.clone());
    let methods = Arc::new(bundle.services().methods);
    let (out, outbox, drained) = outbound();

    out.send(Frame::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        instance: Some(environment.instance.clone()),
        services: methods.services(),
        http_port: 0,
    }));

    let opened = tokio::time::timeout_at(started + HELLO_TIMEOUT, open(&environment, outbox)).await;
    let mut stream = match opened {
        Err(_) => return log.gone("No answer to the Hello within the Hello timeout."),
        Ok(Err(message)) => return log.gone(&message),
        Ok(Ok((HostFrame::Accepted(_), stream))) => stream,
        Ok(Ok((HostFrame::Rejected(rejected), _))) => {
            return log.gone(&format!(
                "The router rejected the Hello: {}: {}",
                rejected.reason, rejected.message
            ));
        }
        Ok(Ok(_)) => {
            return log.gone("The router answered the Hello with another frame than Accepted.");
        }
    };

    log.info("connected");

    let host = Host {
        bundle: Arc::new(bundle),
        calls: Calls::new(methods, out.clone()),
        out,
        log: log.clone(),
    };
    let (stopped, mut stop) = oneshot::channel();
    let mut stopped = Some(stopped);

    loop {
        tokio::select! {
            biased;
            _ = &mut stop => break,
            frame = stream.message() => match frame {
                Ok(Some(ConnectResponse { frame: Some(frame) })) => {
                    if let HostFrame::Stop(_) = frame {
                        stopped.take().into_iter().for_each(|stopped| host.stop(stopped));
                    } else {
                        host.receive(frame).await;
                    }
                }
                Ok(Some(ConnectResponse { frame: None })) => {}
                Ok(None) | Err(_) if stopped.is_none() => {
                    // The stream ended during the stop: the stop still ends.
                    let _ = (&mut stop).await;
                    return ExitCode::SUCCESS;
                }
                Ok(None) => return log.gone("The control stream ended."),
                Err(status) => return log.gone(&format!("The control stream failed: {}", status.message())),
            },
        }
    }

    tokio::select! {
        _ = drained => {}
        () = until_end(&mut stream) => {}
    }
    let _ = tokio::time::timeout(FLUSH_GRACE, until_end(&mut stream)).await;
    log.info("stopped");
    ExitCode::SUCCESS
}

/// Dials the router and opens the control stream; answers its first frame.
async fn open(
    environment: &Environment,
    outbox: Outbox,
) -> Result<(HostFrame, Streaming<ConnectResponse>), String> {
    let channel = Endpoint::from_shared(environment.url.clone())
        .map_err(|error| format!("DORIC_ROUTER_URL is not a URL: {error}."))?
        .connect()
        .await
        .map_err(|error| format!("The router is unreachable: {error}."))?;
    let mut request = tonic::Request::new(outbox);

    request
        .metadata_mut()
        .insert("authorization", environment.authorization.clone());

    let mut stream = BundleHostServiceClient::new(channel)
        .connect(request)
        .await
        .map_err(|status| format!("The control stream did not open: {}", status.message()))?
        .into_inner();

    loop {
        match stream.message().await {
            Ok(Some(ConnectResponse { frame: Some(frame) })) => return Ok((frame, stream)),
            Ok(Some(ConnectResponse { frame: None })) => {}
            Ok(None) => return Err("The control stream ended before Accepted.".to_owned()),
            Err(status) => return Err(format!("The control stream failed: {}", status.message())),
        }
    }
}

/// Reads the stream to its end.
async fn until_end(stream: &mut Streaming<ConnectResponse>) {
    while let Ok(Some(_)) = stream.message().await {}
}

/// The connected bundle: answers the host's frames after `Accepted`.
struct Host<B> {
    bundle: Arc<B>,
    calls: Calls,
    out: Outbound,
    log: Log,
}

impl<B: Bundle> Host<B> {
    /// Answers one frame other than `Stop`; frames the SDK has no use for
    /// are ignored.
    async fn receive(&self, frame: HostFrame) {
        match frame {
            HostFrame::HealthCheck(check) => self
                .out
                .send(Frame::HealthReply(HealthReply { nonce: check.nonce })),
            HostFrame::Activate(_) => self.activate(),
            HostFrame::GenerationChanged(changed) => {
                self.out.send(Frame::GenerationAck(GenerationAck {
                    event: changed.event,
                }));
            }
            HostFrame::CallStart(start) => self.calls.start(start).await,
            HostFrame::CallMessage(message) => self.calls.message(message),
            HostFrame::CallHalfClose(close) => self.calls.half_close(close.call_id),
            HostFrame::CallCancel(cancel) => self.calls.cancel(cancel.call_id),
            HostFrame::CallCredit(credit) => self.calls.credit(credit),
            HostFrame::Accepted(_)
            | HostFrame::Rejected(_)
            | HostFrame::Stop(_)
            | HostFrame::PeerSignal(_)
            | HostFrame::InstanceGone(_)
            | HostFrame::ProviderChanged(_) => {}
        }
    }

    /// Runs `activate` on its own task and answers `ActivateResult`.
    fn activate(&self) {
        let bundle = Arc::clone(&self.bundle);
        let out = self.out.clone();
        let log = self.log.clone();

        tokio::spawn(async move {
            let answer = tokio::spawn(async move { bundle.activate().await })
                .await
                .unwrap_or_else(|_| {
                    Err(ContractError::new("internal", "The activation panicked."))
                });
            let status = match answer {
                Ok(()) => {
                    log.info("activated");
                    codes::ok()
                }
                Err(error) => {
                    log.error(&format!("The activation failed: {error}"));
                    codes::status(&error)
                }
            };

            out.send(Frame::ActivateResult(ActivateResult {
                status: Some(status),
            }));
        });
    }

    /// Waits for the calls in flight, runs `stop`, answers `StopResult` and
    /// closes the stream; then signals `stopped`.
    fn stop(&self, stopped: oneshot::Sender<()>) {
        let bundle = Arc::clone(&self.bundle);
        let calls = self.calls.clone();
        let out = self.out.clone();
        let log = self.log.clone();

        log.info("stopping");
        tokio::spawn(async move {
            calls.idle().await;

            if tokio::spawn(async move { bundle.stop().await })
                .await
                .is_err()
            {
                log.error("The stop panicked.");
            }

            out.send(Frame::StopResult(StopResult {}));
            out.close();
            let _ = stopped.send(());
        });
    }
}

/// The queue of frames to the host; clones share it.
#[derive(Clone)]
pub(crate) struct Outbound(mpsc::UnboundedSender<Option<ConnectRequest>>);

impl Outbound {
    /// Queues a frame; a no-op once the stream is gone.
    pub(crate) fn send(&self, frame: Frame) {
        let _ = self.0.send(Some(ConnectRequest { frame: Some(frame) }));
    }

    /// Ends the request stream after the frames queued so far.
    fn close(&self) {
        let _ = self.0.send(None);
    }
}

/// The request stream of the control stream: the queued frames up to
/// [`Outbound::close`]. Signals once it has handed out its last frame.
struct Outbox {
    frames: mpsc::UnboundedReceiver<Option<ConnectRequest>>,
    drained: Option<oneshot::Sender<()>>,
}

fn outbound() -> (Outbound, Outbox, oneshot::Receiver<()>) {
    let (send, frames) = mpsc::unbounded_channel();
    let (drained, done) = oneshot::channel();

    (
        Outbound(send),
        Outbox {
            frames,
            drained: Some(drained),
        },
        done,
    )
}

impl Stream for Outbox {
    type Item = ConnectRequest;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.drained.is_none() {
            return Poll::Ready(None);
        }

        match self.frames.poll_recv(context) {
            Poll::Ready(Some(Some(frame))) => Poll::Ready(Some(frame)),
            Poll::Ready(Some(None) | None) => {
                self.drained.take().into_iter().for_each(|drained| {
                    let _ = drained.send(());
                });
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// The log of the instance, once [`serve`] has read the environment; the
/// context of [`crate::log`].
static CONTEXT: OnceLock<Log> = OnceLock::new();

/// Writes the line of [`crate::log`]: with the instance once [`serve`] has
/// read the environment, without it before.
pub(crate) fn log(level: Level, msg: &str) {
    CONTEXT
        .get()
        .cloned()
        .unwrap_or_default()
        .line(level.name(), msg);
}

/// JSON lines on stdout with `level`, `msg` and the instance.
#[derive(Clone, Default)]
struct Log {
    /// The instance's fields, rendered, each with its leading comma.
    instance: String,
}

impl Log {
    fn new(instance: &Instance) -> Self {
        Self {
            instance: format!(
                ",\"bundleId\":{},\"generation\":{},\"incarnation\":{}",
                quote(&instance.bundle_id),
                instance.generation,
                instance.incarnation
            ),
        }
    }

    fn info(&self, msg: &str) {
        self.line("info", msg);
    }

    fn error(&self, msg: &str) {
        self.line("error", msg);
    }

    /// Logs why the host is gone and answers exit code 70.
    fn gone(&self, msg: &str) -> ExitCode {
        self.error(msg);
        ExitCode::from(HOST_GONE)
    }

    /// Writes one line; a failed write is dropped, so logging never fails.
    fn line(&self, level: &str, msg: &str) {
        let _ = writeln!(std::io::stdout().lock(), "{}", self.render(level, msg));
    }

    /// The JSON line, without its newline.
    fn render(&self, level: &str, msg: &str) -> String {
        format!(
            "{{\"level\":{},\"msg\":{}{}}}",
            quote(level),
            quote(msg),
            self.instance
        )
    }
}

/// A JSON string of `text`.
fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);

    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            control if control < ' ' => quoted.push_str(&format!("\\u{:04x}", control as u32)),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_carries_the_instance_once_it_is_known() {
        let log = Log::new(&Instance {
            bundle_id: "sqlite".to_owned(),
            generation: 2,
            incarnation: 3,
        });

        assert_eq!(
            log.render(Level::Warn.name(), "a \"b\""),
            r#"{"level":"warn","msg":"a \"b\"","bundleId":"sqlite","generation":2,"incarnation":3}"#
        );
        assert_eq!(
            Log::default().render(Level::Info.name(), "open"),
            r#"{"level":"info","msg":"open"}"#
        );
    }

    #[test]
    fn log_writes_without_an_instance_before_serve_and_never_fails() {
        crate::log(Level::Debug, "before serve");
        crate::log(Level::Error, "");
    }

    #[test]
    fn quotes_text_as_a_json_string() {
        assert_eq!(quote("a \"b\"\\\n\u{1}é"), r#""a \"b\"\\\n\u0001é""#);
    }
}
