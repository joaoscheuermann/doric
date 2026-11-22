//! Phase 0 spike (T0.1): the native stub of the `sqlite` bundle. It opens the
//! control stream on the router listener, sends a `Hello`, and keeps the
//! stream open until the host closes it, as a bundle process would.
#![forbid(unsafe_code)]

use std::{env, process::ExitCode, time::Duration};

use tokio::sync::mpsc;
use tokio_stream::{StreamExt, wrappers::ReceiverStream};
use tonic::{Request, metadata::MetadataValue, transport::Endpoint};

/// The generated messages and client of `doric.platform.v1`, nested by
/// package so their references to `google.rpc` resolve.
pub mod doric {
    pub mod platform {
        pub mod v1 {
            tonic::include_proto!("doric.platform.v1");
        }
    }
}

/// `google.rpc`, which `control.proto` imports.
pub mod google {
    pub mod rpc {
        tonic::include_proto!("google.rpc");
    }
}

use doric::platform::v1::{
    ConnectRequest, Hello, Instance, bundle_host_service_client::BundleHostServiceClient,
    connect_request, connect_response,
};

/// The control protocol version this stub speaks.
const PROTOCOL_VERSION: u32 = 1;
/// How long the stub waits for `Accepted` after it sent its `Hello`.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// The exit code of a bundle whose host is gone (spec, section 7, "Spawn").
const EXIT_HOST_GONE: u8 = 70;

/// What the supervisor passes in the environment of a spawned instance.
struct Launch {
    router_url: String,
    token: String,
    instance: Instance,
}

impl Launch {
    fn from_env() -> Result<Self, String> {
        let var = |name: &str| env::var(name).map_err(|_| format!("{name} is not set"));
        let number = |name: &str| {
            var(name)?
                .parse::<u32>()
                .map_err(|error| format!("{name}: {error}"))
        };
        Ok(Self {
            router_url: var("DORIC_ROUTER_URL")?,
            token: var("DORIC_INSTANCE_TOKEN")?,
            instance: Instance {
                bundle_id: var("DORIC_BUNDLE_ID")?,
                generation: number("DORIC_GENERATION")?,
                incarnation: number("DORIC_INCARNATION")?,
            },
        })
    }
}

/// The first frame of the control stream.
fn hello(instance: Instance) -> ConnectRequest {
    ConnectRequest {
        frame: Some(connect_request::Frame::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            instance: Some(instance),
            services: Vec::new(),
            http_port: 0,
        })),
    }
}

async fn run(launch: Launch) -> Result<(), String> {
    let channel = Endpoint::from_shared(launch.router_url)
        .map_err(|error| format!("DORIC_ROUTER_URL: {error}"))?
        .connect()
        .await
        .map_err(|error| format!("connect: {error}"))?;
    let mut client = BundleHostServiceClient::new(channel);
    let (frames, outgoing) = mpsc::channel(8);
    frames
        .send(hello(launch.instance))
        .await
        .map_err(|error| format!("hello: {error}"))?;

    let mut request = Request::new(ReceiverStream::new(outgoing));
    let bearer = MetadataValue::try_from(format!("Bearer {}", launch.token))
        .map_err(|error| format!("token: {error}"))?;
    request.metadata_mut().insert("authorization", bearer);

    let mut incoming = client
        .connect(request)
        .await
        .map_err(|status| format!("control stream: {status}"))?
        .into_inner();

    let first = tokio::time::timeout(HELLO_TIMEOUT, incoming.next())
        .await
        .map_err(|_| "no answer to the Hello".to_owned())?;
    match first
        .and_then(Result::ok)
        .and_then(|response| response.frame)
    {
        Some(connect_response::Frame::Accepted(_)) => {}
        Some(connect_response::Frame::Rejected(rejected)) => {
            return Err(format!("rejected: {}", rejected.reason));
        }
        _ => return Err("the stream ended before Accepted".to_owned()),
    }

    // Idle until the host closes the stream; `frames` stays alive meanwhile.
    while incoming.next().await.is_some() {}
    drop(frames);
    Err("the control stream closed".to_owned())
}

#[tokio::main]
async fn main() -> ExitCode {
    let outcome = match Launch::from_env() {
        Ok(launch) => run(launch).await,
        Err(error) => Err(error),
    };
    outcome.map_or_else(
        |error| {
            eprintln!("doric-spike-stub: {error}");
            ExitCode::from(EXIT_HOST_GONE)
        },
        |()| ExitCode::SUCCESS,
    )
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;

    #[test]
    fn hello_encodes_protocol_version_one() {
        let instance = Instance {
            bundle_id: "sqlite".to_owned(),
            generation: 1,
            incarnation: 1,
        };

        let decoded = ConnectRequest::decode(hello(instance.clone()).encode_to_vec().as_slice())
            .expect("a Hello decodes");

        let Some(connect_request::Frame::Hello(hello)) = decoded.frame else {
            panic!("the first frame is a Hello");
        };
        assert_eq!(hello.protocol_version, 1);
        assert_eq!(hello.instance, Some(instance));
    }
}
