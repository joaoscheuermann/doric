//! Generates, from the exported protos (`dist/proto`, the root `proto-export`
//! target), the messages of `doric.storage.v2` and `doric.storage.layout.v1`,
//! which `src/lib.rs` includes from `OUT_DIR`.

use std::path::PathBuf;

/// The storage service is served through the SDK, so only its messages are
/// generated.
const STORAGE: &str = "doric/storage/v2/storage.proto";
/// The engine's records of the layout.
const LAYOUT: &str = "doric/storage/layout/v1/layout.proto";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../dist/proto");
    let files = [STORAGE, LAYOUT].map(|name| root.join(name));
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
    }

    let mut descriptors = protox::compile(&files, [&root])?;
    // Their other imports carry only options; the well-known types stay in the
    // set for the generator's message graph, and are `prost_types`'.
    descriptors.file.retain(|file| {
        [STORAGE, LAYOUT].contains(&file.name()) || file.name().starts_with("google/protobuf/")
    });
    descriptors
        .file
        .iter_mut()
        .for_each(|file| file.service.clear());
    tonic_prost_build::configure()
        .build_server(false)
        .build_client(false)
        .compile_fds(descriptors)?;
    Ok(())
}
