//! The `google.rpc.Status` of a [`ContractError`] (spec section 3, "Errors"):
//! a copy of the error table of `packages/bundle/src/contracts/status.ts`.

use prost::Message;
use tonic::Code;

use crate::{
    ContractError,
    proto::{
        doric::platform::v1::ErrorDetails,
        google::rpc::{ErrorInfo, Status},
    },
};

/// The `google.rpc.ErrorInfo.domain` under which a Doric error code travels.
const DOMAIN: &str = "doric";

/// The type URLs of the details a status carries.
const ERROR_INFO_URL: &str = "type.googleapis.com/google.rpc.ErrorInfo";
const ERROR_DETAILS_URL: &str = "type.googleapis.com/doric.platform.v1.ErrorDetails";

/// The rows of the error table: each gRPC code with the Doric codes it carries.
const TABLE: &[(Code, &[&str])] = &[
    (
        Code::InvalidArgument,
        &[
            "invalid_input",
            "invalid_scope",
            "invalid_stream",
            "invalid_index_value",
            "credential_invalid",
            "invalid_config",
            "invalid_credential",
            "invalid_provider",
            "invalid_project",
            "invalid_project_color",
            "invalid_thread",
            "invalid_project_path",
            "invalid_execution",
            "invalid_branch",
            "invalid_prompt",
            "invalid_steer",
            "invalid_resume",
            "invalid_rewind",
            "invalid_interrupt",
            "invalid_terminal",
            "invalid_cursor",
            "invalid_size",
            "invalid_credential_id",
            "invalid_project_id",
            "invalid_thread_id",
            "invalid_page",
            "invalid_cwd",
            "invalid_event_cursor",
        ],
    ),
    (
        Code::Unauthenticated,
        &["invalid_instance_token", "instance_revoked"],
    ),
    (
        Code::PermissionDenied,
        &["undeclared_requirement", "undeclared_provide", "not_owner"],
    ),
    (
        Code::NotFound,
        &[
            "unknown_type",
            "unknown_settings",
            "unknown_event",
            "unknown_kind",
            "settings_missing",
            "credential_missing",
            "not_found",
            "unknown_command",
            "unknown_provider",
            "unknown_session",
            "unknown_lease",
            "credential_not_found",
            "vm_not_found",
            "project_not_found",
            "project_path_not_found",
            "thread_not_found",
            "prompt_not_found",
            "unknown_prompt",
            "missing",
            "terminal_missing",
        ],
    ),
    (
        Code::AlreadyExists,
        &[
            "registration_conflict",
            "duplicate_tool",
            "duplicate_skill",
            "credential_name_taken",
            "duplicate_credential_kind",
            "provider_conflict",
            "route_conflict",
        ],
    ),
    (
        Code::Aborted,
        &[
            "revision_conflict",
            "sequence_conflict",
            "unique_conflict",
            "settings_conflict",
            "condition_failed",
        ],
    ),
    (Code::ResourceExhausted, &["limit_exceeded"]),
    (
        Code::Unimplemented,
        &["unknown_contract", "unsupported_operation"],
    ),
    (
        Code::Unavailable,
        &[
            "unavailable",
            "generation_lost",
            "credential_storage_unavailable",
            "disconnected",
            "storage_not_migrated",
            "configuration_rejected",
            "model_catalog_unreadable",
            "compaction_failed",
        ],
    ),
    (
        Code::Internal,
        &[
            "internal",
            "invalid_output",
            "protocol_error",
            "replay_failed",
            "internal_error",
        ],
    ),
];

/// The gRPC code of a Doric code; `FAILED_PRECONDITION` for a code without a
/// row, since codes are an open set.
pub(crate) fn grpc(code: &str) -> Code {
    TABLE
        .iter()
        .find(|(_, codes)| codes.contains(&code))
        .map_or(Code::FailedPrecondition, |(grpc, _)| *grpc)
}

/// The status of success.
pub(crate) fn ok() -> Status {
    Status::default()
}

/// The status of a call that ended after it was cancelled.
pub(crate) fn cancelled() -> Status {
    Status {
        code: Code::Cancelled as i32,
        message: "The call was cancelled.".to_owned(),
        details: Vec::new(),
    }
}

/// The status of an error: its gRPC code, its message, its `ErrorInfo` and,
/// when it has details, its `ErrorDetails`.
pub(crate) fn status(error: &ContractError) -> Status {
    let info = ErrorInfo {
        reason: error.code.clone(),
        domain: DOMAIN.to_owned(),
        metadata: Default::default(),
    };
    let details = error.details.clone().map(|details| ErrorDetails {
        details: Some(details),
    });

    Status {
        code: grpc(&error.code) as i32,
        message: error.message.clone(),
        details: std::iter::once(any(ERROR_INFO_URL, &info))
            .chain(details.map(|details| any(ERROR_DETAILS_URL, &details)))
            .collect(),
    }
}

fn any(type_url: &str, message: &impl Message) -> prost_types::Any {
    prost_types::Any {
        type_url: type_url.to_owned(),
        value: message.encode_to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_one_code_of_each_row_to_its_grpc_code() {
        let cases = [
            ("invalid_input", Code::InvalidArgument),
            ("invalid_instance_token", Code::Unauthenticated),
            ("not_owner", Code::PermissionDenied),
            ("not_found", Code::NotFound),
            ("registration_conflict", Code::AlreadyExists),
            ("revision_conflict", Code::Aborted),
            ("limit_exceeded", Code::ResourceExhausted),
            ("unknown_contract", Code::Unimplemented),
            ("unavailable", Code::Unavailable),
            ("internal", Code::Internal),
        ];

        for (code, expected) in cases {
            assert_eq!(grpc(code), expected, "{code}");
        }
    }

    #[test]
    fn maps_a_code_without_a_row_to_failed_precondition() {
        assert_eq!(grpc("local_only"), Code::FailedPrecondition);
        assert_eq!(grpc("conformance_refused"), Code::FailedPrecondition);
    }

    #[test]
    fn carries_error_info_and_details_in_the_status() {
        let details = prost_types::Struct::default();
        let error = ContractError {
            details: Some(details.clone()),
            ..ContractError::new("not_found", "Gone.")
        };

        let status = status(&error);

        assert_eq!(status.code, Code::NotFound as i32);
        assert_eq!(status.message, "Gone.");
        assert_eq!(
            status.details,
            [
                any(
                    ERROR_INFO_URL,
                    &ErrorInfo {
                        reason: "not_found".to_owned(),
                        domain: "doric".to_owned(),
                        metadata: Default::default(),
                    },
                ),
                any(
                    ERROR_DETAILS_URL,
                    &ErrorDetails {
                        details: Some(details),
                    },
                ),
            ]
        );
    }
}
