//! The conformance fixture of the Rust SDK (spec `docs/designs/grpc-processes.md`,
//! section 10, "Protocol conformance across SDKs"; T4.5): a bundle that serves
//! `doric.conformance.v1.ConformanceService` through `doric_bundle`, for the
//! suite of `bundle/testing`, which plays the router. It mirrors the
//! TypeScript fixture of `packages/bundle/tests/fixtures/conformance/` method
//! for method; `DORIC_CONFORMANCE_ACTIVATE=fail` makes its activation fail.
//! `packages/bundle/tests/conformance/rust.test.ts` runs the suite against it.
#![forbid(unsafe_code)]

use std::{
    collections::HashMap,
    process::{Command, ExitCode},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, UNIX_EPOCH},
};

use doric_bundle::{Bundle, Call, ContractError, Requests, Services, Stream};
use tokio_stream::StreamExt;

/// The generated messages of `doric.conformance.v1` (messages only; the SDK
/// serves the service).
#[allow(dead_code, clippy::all)]
mod conformance {
    include!(concat!(env!("OUT_DIR"), "/doric.conformance.v1.rs"));
}

use conformance::{
    CountRequest, CountResponse, EchoRequest, EchoResponse, FailRequest, FailResponse,
    FreezeRequest, FreezeResponse, ObservedRequest, ObservedResponse, SumRequest, SumResponse,
    WaitRequest, WaitResponse,
};

/// The path of a method of the conformance service.
macro_rules! method {
    ($name:literal) => {
        concat!("/doric.conformance.v1.ConformanceService/", $name)
    };
}

/// What one `Wait` call saw; its handler updates it when it answers or sees
/// the call cancelled.
type Observation = Arc<Mutex<ObservedResponse>>;

/// What each `Wait` call saw, by its key; a later `Wait` replaces it.
type Observations = Arc<Mutex<HashMap<String, Observation>>>;

/// The fixture bundle.
struct Fixture {
    /// `DORIC_CONFORMANCE_ACTIVATE=fail` was set at start.
    activation_fails: bool,
    observations: Observations,
}

impl Bundle for Fixture {
    fn services(&self) -> Services {
        let waits = Arc::clone(&self.observations);
        let reads = Arc::clone(&self.observations);

        Services::new()
            .unary(method!("Echo"), echo)
            .server_stream(method!("Count"), count)
            .client_stream(method!("Sum"), sum)
            .unary(method!("Fail"), fail)
            .unary(method!("Wait"), move |call, request| {
                wait(Arc::clone(&waits), call, request)
            })
            .unary(method!("Observed"), move |_call, request| {
                observed(Arc::clone(&reads), request)
            })
            .unary(method!("Freeze"), freeze)
    }

    async fn activate(&self) -> Result<(), ContractError> {
        if self.activation_fails {
            return Err(ContractError {
                code: "activation_failed".to_owned(),
                message: "The fixture fails its activation (DORIC_CONFORMANCE_ACTIVATE=fail)."
                    .to_owned(),
                details: None,
            });
        }

        Ok(())
    }

    async fn stop(&self) {}
}

/// `Echo`: answers the request's text with `pad_bytes` bytes of padding.
async fn echo(_call: Call, request: EchoRequest) -> Result<EchoResponse, ContractError> {
    Ok(EchoResponse {
        padding: vec![0; request.pad_bytes as usize],
        text: request.text,
    })
}

/// `Count`: answers `n` messages, `index` 0 to n - 1.
fn count(
    _call: Call,
    request: CountRequest,
) -> impl Stream<Item = Result<CountResponse, ContractError>> + Send + 'static {
    tokio_stream::iter((0..request.n).map(|index| Ok(CountResponse { index })))
}

/// `Sum`: answers the sum and the number of the request messages.
async fn sum(
    _call: Call,
    mut requests: Requests<SumRequest>,
) -> Result<SumResponse, ContractError> {
    let mut response = SumResponse::default();

    while let Some(request) = requests.next().await {
        response.total = response.total.wrapping_add(request?.value);
        response.count += 1;
    }

    Ok(response)
}

/// `Fail`: fails with the `ContractError` the request names.
async fn fail(_call: Call, request: FailRequest) -> Result<FailResponse, ContractError> {
    Err(ContractError {
        code: request.code,
        message: request.message,
        details: request.details,
    })
}

/// `Wait`: records what it sees of the call under `key`, then answers after
/// `hold_ms`, or, with `hold_ms` 0, runs until the call is cancelled.
async fn wait(
    observations: Observations,
    call: Call,
    request: WaitRequest,
) -> Result<WaitResponse, ContractError> {
    let observation = Arc::new(Mutex::new(ObservedResponse {
        found: true,
        caller_bundle_id: call.caller.bundle_id.clone(),
        caller_version: call.caller.version.clone(),
        caller_generation: call.caller.generation,
        scope: call.scope.clone(),
        traceparent: call.traceparent.clone(),
        deadline_unix_ms: call
            .deadline
            .and_then(|deadline| deadline.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |since| since.as_millis() as f64),
        cancelled: false,
        answered: false,
    }));
    observations
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(request.key.clone(), Arc::clone(&observation));

    let held = async {
        match request.hold_ms {
            0 => std::future::pending().await,
            hold => tokio::time::sleep(Duration::from_millis(hold.into())).await,
        }
    };
    let answered = tokio::select! {
        () = call.cancelled.cancelled() => false,
        () = held => true,
    };
    let mut seen = observation.lock().unwrap_or_else(PoisonError::into_inner);

    if answered {
        seen.answered = true;
        return Ok(WaitResponse { key: request.key });
    }

    seen.cancelled = true;
    Err(ContractError {
        code: "cancelled".to_owned(),
        message: "The call was cancelled.".to_owned(),
        details: None,
    })
}

/// `Observed`: answers what the `Wait` call of `key` saw.
async fn observed(
    observations: Observations,
    request: ObservedRequest,
) -> Result<ObservedResponse, ContractError> {
    let observation = observations
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request.key)
        .cloned();

    Ok(observation.map_or_else(ObservedResponse::default, |seen| {
        seen.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }))
}

/// `Freeze`: stops the process with `SIGSTOP`; it may never answer.
async fn freeze(_call: Call, _request: FreezeRequest) -> Result<FreezeResponse, ContractError> {
    Command::new("kill")
        .args(["-STOP", &std::process::id().to_string()])
        .status()
        .map(|_| FreezeResponse {})
        .map_err(|error| ContractError {
            code: "internal".to_owned(),
            message: format!("The fixture could not stop itself: {error}."),
            details: None,
        })
}

fn main() -> ExitCode {
    doric_bundle::run(Fixture {
        activation_fails: std::env::var("DORIC_CONFORMANCE_ACTIVATE")
            .is_ok_and(|value| value == "fail"),
        observations: Observations::default(),
    })
}
