//! `storage/v2.Read` and the stream ids of every stream item (spec "The
//! storage contract", "Read", and "The layout"): a stream's id is checked
//! before any I/O ([`checked`], [`check`]), then a page is read in one read
//! transaction ([`read`]).

use std::ops::ControlFlow;

use doric_bundle::ContractError;
use doric_sqlite::{KeyRange, ReadTxn, refusal};

use crate::{
    commit::transaction::{detailed, internal},
    keys::{self, Element},
    layout::{self, StreamEntryHeader, StreamHead, TruncationMark},
    v2::{self, ReadRequest, ReadResponse, StreamEntry, StreamPage, read_response::Item},
};

/// The most UTF-8 bytes of a stream id.
pub const STREAM_ID_BYTES: usize = 512;

/// Checks a stream id for the bundle `owner` before any I/O, in this order:
/// its length, then its form, today's `streamIdPattern`
/// (`packages/storage/src/streams.ts:7`, `<owner>.<family>/<key>`, a key
/// without whitespace as JavaScript's `\s` reads it: U+FEFF is whitespace,
/// U+0085 is not), then its owner, the part before its first `.`.
///
/// # Errors
///
/// `invalid_input` (detail `stream`) for an id over [`STREAM_ID_BYTES`]
/// bytes; then `invalid_stream` (detail `stream`) for an id that does not
/// match the pattern; then `not_owner` (detail `stream`) for a stream of
/// another bundle than `owner`.
pub fn checked(owner: &str, stream: &str) -> Result<(), ContractError> {
    if stream.len() > STREAM_ID_BYTES {
        return Err(refusal(
            "invalid_input",
            format!(
                "A stream id holds at most {STREAM_ID_BYTES} bytes; this one holds {}.",
                stream.len()
            ),
            "stream",
            stream.into(),
        ));
    }
    if !well_formed(stream) {
        return Err(refusal(
            "invalid_stream",
            format!("\"{stream}\" is not a stream ID of the form <owner>.<family>/<key>."),
            "stream",
            stream.into(),
        ));
    }
    if stream.split('.').next() != Some(owner) {
        return Err(refusal(
            "not_owner",
            format!("The stream \"{stream}\" is not of the bundle {owner}."),
            "stream",
            stream.into(),
        ));
    }
    Ok(())
}

/// Whether `stream` matches `streamIdPattern`,
/// `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\/[^\s]+$`.
fn well_formed(stream: &str) -> bool {
    let Some((family, key)) = stream.split_once('/') else {
        return false;
    };
    let mut segments = family.split('.');
    let first = segments.next().unwrap_or_default();
    let segment = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };
    let mut rest = segments.peekable();
    first.starts_with(|c: char| c.is_ascii_lowercase())
        && segment(first)
        && rest.peek().is_some()
        && rest.all(segment)
        && !key.is_empty()
        && !key.chars().any(js_whitespace)
}

/// Whether JavaScript's `\s` matches `c`: `WhiteSpace` and `LineTerminator`,
/// U+FEFF included and U+0085 not.
fn js_whitespace(c: char) -> bool {
    ('\u{2000}'..='\u{200A}').contains(&c)
        || "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
            .contains(c)
}

/// `value`, the sequence `field` of a request, as a whole number from 0 to
/// `u32::MAX`.
///
/// # Errors
///
/// `invalid_input` for any other value.
pub(crate) fn whole_sequence(value: f64, field: &str) -> Result<u32, ContractError> {
    if value.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&value) {
        // A whole number within the range converts exactly.
        Ok(value as u32)
    } else {
        Err(ContractError::new(
            "invalid_input",
            format!(
                "{field} is a whole number from 0 to {}; {value} is not.",
                u32::MAX
            ),
        ))
    }
}

/// `invalid_input` (details `{stream, afterSequence, lastSequence}`) for a
/// `verb` (`read`, `truncated`) of `stream` after `after`, past its last
/// sequence `last`.
pub(crate) fn past_end(stream: &str, verb: &str, after: u32, last: u32) -> ContractError {
    detailed(
        "invalid_input",
        format!("Stream {stream} cannot be {verb} after {after}: its last sequence is {last}."),
        [
            ("stream", stream.into()),
            ("afterSequence", f64::from(after).into()),
            ("lastSequence", f64::from(last).into()),
        ],
    )
}

/// A checked `Read` ([`check`]): its stream, the sequence it starts after
/// and the most entries its page holds.
#[derive(Debug, Clone)]
pub struct Read {
    /// The stream's id, the bundle's.
    stream: String,
    /// The sequence the page starts after.
    after: u32,
    /// The most entries of the page, 1 or more.
    limit: usize,
}

/// Checks the `Read` request `request` of the bundle `bundle` before any I/O,
/// in this order: a request with no `stream_read`, then [`checked`], then
/// `after_sequence`, then `limit`.
///
/// # Errors
///
/// `invalid_input` for a request with no `stream_read`; the errors of
/// [`checked`]; `invalid_input` for an `after_sequence` that is not a whole
/// number from 0 to `u32::MAX`; `invalid_input` for a `limit` of 0 or less.
pub fn check(bundle: &str, request: &ReadRequest) -> Result<Read, ContractError> {
    let Some(read) = &request.stream_read else {
        return Err(ContractError::new(
            "invalid_input",
            "A read has no stream_read.",
        ));
    };
    checked(bundle, &read.stream)?;
    let after = whole_sequence(read.after_sequence, "afterSequence")?;
    let limit = usize::try_from(read.limit)
        .ok()
        .filter(|&limit| limit > 0)
        .ok_or_else(|| {
            ContractError::new(
                "invalid_input",
                format!("A read's limit is above 0; {} is not.", read.limit),
            )
        })?;
    Ok(Read {
        stream: read.stream.clone(),
        after,
        limit,
    })
}

/// Reads the page `read` of `bundle`'s stream in `txn`, one read transaction,
/// and emits it: first a `page` item with the stream's `last_sequence` (0 for
/// an absent stream) and its truncation marks with `after_sequence <
/// read.after <= at_sequence`, in the order of their commits' positions; then
/// at most `read.limit` entries with a sequence above `read.after`, in
/// sequence order, each an `entry` item followed by its event in `chunk`
/// items of 1 to 1,048,576 bytes. Only the keys of the entries emitted are
/// scanned, then each header and chunk is read. A `Break` of `emit` ends the
/// read.
///
/// # Errors
///
/// `invalid_input` (details `{stream, afterSequence, lastSequence}`) for a
/// `read.after` above the stream's last sequence, before any item;
/// `internal` for a stored head, entry or mark that does not decode; the
/// errors of [`ReadTxn::get`] and [`ReadTxn::range`].
pub fn read(
    txn: &mut dyn ReadTxn,
    bundle: &str,
    read: &Read,
    emit: &mut dyn FnMut(ReadResponse) -> ControlFlow<()>,
) -> Result<(), ContractError> {
    let stream = read.stream.as_str();
    let last = match txn.get(&layout::head(bundle, stream))? {
        Some((value, _)) => decoded::<StreamHead>(&value, "head")?.last_sequence,
        None => 0,
    };
    if read.after > last {
        return Err(past_end(stream, "read", read.after, last));
    }
    let mut truncations = Vec::new();
    let mut failure = None;
    txn.range(
        &layout::under(bundle, &["stream.mark", stream]),
        &mut |entry| match decoded::<TruncationMark>(entry.value, "truncation mark") {
            Ok(mark) => {
                if mark.after_sequence < read.after && read.after <= mark.at_sequence {
                    truncations.push(v2::TruncationMark {
                        after_sequence: f64::from(mark.after_sequence),
                        at_sequence: f64::from(mark.at_sequence),
                    });
                }
                ControlFlow::Continue(())
            }
            Err(error) => {
                failure = Some(error);
                ControlFlow::Break(())
            }
        },
    )?;
    if let Some(error) = failure {
        return Err(error);
    }
    let page = Item::Page(StreamPage {
        last_sequence: f64::from(last),
        truncations,
    });
    if send(emit, page).is_break() {
        return Ok(());
    }

    let mut keys = Vec::new();
    if let Some(first) = read.after.checked_add(1) {
        let range = KeyRange {
            keys_only: true,
            ..layout::entries_from(bundle, "stream.entry", stream, first)
        };
        txn.range(&range, &mut |entry| {
            keys.push(entry.key.to_vec());
            if keys.len() < read.limit {
                ControlFlow::Continue(())
            } else {
                ControlFlow::Break(())
            }
        })?;
    }
    let prefix = bundle.len() + 1;
    for key in keys {
        let sequence = match keys::decode(&key[prefix..])?.last() {
            Some(&Element::Number(sequence)) => sequence,
            _ => {
                return Err(internal(
                    "A stored stream entry key has no sequence.".into(),
                ));
            }
        };
        let Some((value, _)) = txn.get(&key)? else {
            return Err(internal("A stored stream entry is missing.".into()));
        };
        let header = decoded::<StreamEntryHeader>(&value, "entry")?;
        let entry = Item::Entry(StreamEntry {
            sequence,
            created_at: header.created_at,
        });
        if send(emit, entry).is_break()
            || (!header.chunk.is_empty() && send(emit, Item::Chunk(header.chunk)).is_break())
        {
            return Ok(());
        }
        // The sequence of a key of this stream's entries is a u32.
        let sequence = sequence as u32;
        for n in 1..=header.chunk_count {
            let Some((chunk, _)) = txn.get(&layout::entry_chunk(bundle, stream, sequence, n))?
            else {
                return Err(internal(format!(
                    "The chunk {n} of the entry {sequence} of {stream} is missing."
                )));
            };
            if send(emit, Item::Chunk(chunk)).is_break() {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Emits `item`.
fn send(emit: &mut dyn FnMut(ReadResponse) -> ControlFlow<()>, item: Item) -> ControlFlow<()> {
    emit(ReadResponse { item: Some(item) })
}

/// The stored record `value`, a stream's `what`; `internal` when it does not
/// decode.
pub(crate) fn decoded<M: prost::Message + Default>(
    value: &[u8],
    what: &str,
) -> Result<M, ContractError> {
    M::decode(value)
        .map_err(|error| internal(format!("A stored stream {what} does not decode: {error}.")))
}

#[cfg(test)]
mod tests;
