// A copy of `runtime`'s generated `runtime.attachments/v1` code
// (`bundles/runtime/runtime/src/contracts/gen/doric/runtime/attachments/v1/attachments_pb.ts`),
// for the fake attachments service of the `llms/rpc` tests: `llms` may not
// depend on `runtime` (`runtime` → `host-config` → `llms`). The descriptor is
// the same bytes, so the service has the same full name and wire shape.
// `runtime.attachments/v1` (host, 1.1.0): the images of the calling Project,
// served by `runtime`. An image is kept once as a content-addressed blob and
// named in text by a Markdown line `![name](doric-attachment:<id>)`, so
// prompts, queued inputs and tool results stay text. `Attach` keeps an image
// for the Thread of the scope's `threadId`, deleted with that Thread or its
// Project; `Read` answers for the scope's `projectId` or the Project of its
// `threadId`, so every Thread of a Project reads its images. A call without
// that scope fails with `INVALID_ARGUMENT`.
//
// 1.1.0: `attach` takes the bytes client streaming and `read` answers them
// server streaming, instead of base64 text.

// @generated from file doric/runtime/attachments/v1/attachments.proto (package doric.runtime.attachments.v1, syntax proto3)
/* eslint-disable */

import type { Message } from '@bufbuild/protobuf';
import type {
  GenFile,
  GenMessage,
  GenService,
} from '@bufbuild/protobuf/codegenv2';
import {
  fileDesc,
  messageDesc,
  serviceDesc,
} from '@bufbuild/protobuf/codegenv2';
import { file_buf_validate_validate } from 'bundle/contracts/gen/buf/validate/validate_pb.js';
import { file_doric_platform_v1_options } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

/**
 * Describes the file doric/runtime/attachments/v1/attachments.proto.
 */
export const file_doric_runtime_attachments_v1_attachments: GenFile =
  /*@__PURE__*/
  fileDesc(
    'Ci5kb3JpYy9ydW50aW1lL2F0dGFjaG1lbnRzL3YxL2F0dGFjaG1lbnRzLnByb3RvEhxkb3JpYy5ydW50aW1lLmF0dGFjaG1lbnRzLnYxIpICCgpBdHRhY2htZW50EigKAmlkGAEgASgJQhy6SBlyFzIVXnNoYTI1Ni1bMC05YS1mXXs2NH0kEhgKBG5hbWUYAiABKAlCCrpIB3IFEAEYyAESRwoKbWVkaWFfdHlwZRgDIAEoCUIzukgwci5SCWltYWdlL3BuZ1IKaW1hZ2UvanBlZ1IKaW1hZ2Uvd2VicFIJaW1hZ2UvZ2lmEncKBHNpemUYBCABKAFCabpIZroBTwoMc2l6ZS5pbnRlZ2VyEiRzaXplIG11c3QgYmUgYSB3aG9sZSBudW1iZXIgb2YgYnl0ZXMaGXRoaXMgPT0gZG91YmxlKGludCh0aGlzKSkSEhkAAAAAAABUQSEAAAAAAAAAACIaCgpBdHRhY2hIZWFkEgwKBG5hbWUYASABKAkidgoNQXR0YWNoUmVxdWVzdBI4CgRoZWFkGAEgASgLMiguZG9yaWMucnVudGltZS5hdHRhY2htZW50cy52MS5BdHRhY2hIZWFkSAASHAoFY2h1bmsYAiABKAxCC7pICHoGEAEYgIBASABCDQoEaXRlbRIFukgCCAEiVgoOQXR0YWNoUmVzcG9uc2USRAoKYXR0YWNobWVudBgBIAEoCzIoLmRvcmljLnJ1bnRpbWUuYXR0YWNobWVudHMudjEuQXR0YWNobWVudEIGukgDyAEBIhkKC1JlYWRSZXF1ZXN0EgoKAmlkGAEgASgJIlwKCFJlYWRIZWFkEkEKCmF0dGFjaG1lbnQYASABKAsyKC5kb3JpYy5ydW50aW1lLmF0dGFjaG1lbnRzLnYxLkF0dGFjaG1lbnRIAIgBAUINCgtfYXR0YWNobWVudCJzCgxSZWFkUmVzcG9uc2USNgoEaGVhZBgBIAEoCzImLmRvcmljLnJ1bnRpbWUuYXR0YWNobWVudHMudjEuUmVhZEhlYWRIABIcCgVjaHVuaxgCIAEoDEILukgIegYQARiAgEBIAEINCgRpdGVtEgW6SAIIATLsAQoSQXR0YWNobWVudHNTZXJ2aWNlEm0KBkF0dGFjaBIrLmRvcmljLnJ1bnRpbWUuYXR0YWNobWVudHMudjEuQXR0YWNoUmVxdWVzdBosLmRvcmljLnJ1bnRpbWUuYXR0YWNobWVudHMudjEuQXR0YWNoUmVzcG9uc2UiBsK8GAIIASgBEmcKBFJlYWQSKS5kb3JpYy5ydW50aW1lLmF0dGFjaG1lbnRzLnYxLlJlYWRSZXF1ZXN0GiouZG9yaWMucnVudGltZS5hdHRhY2htZW50cy52MS5SZWFkUmVzcG9uc2UiBsK8GAIIATABQiCiuxgcChZydW50aW1lLmF0dGFjaG1lbnRzL3YxEAEYAWIGcHJvdG8z',
    [file_buf_validate_validate, file_doric_platform_v1_options],
  );

/**
 * One stored attachment.
 *
 * @generated from message doric.runtime.attachments.v1.Attachment
 */
export type Attachment = Message<'doric.runtime.attachments.v1.Attachment'> & {
  /**
   * The reference a line names: `sha256-<64 hex>`, the blob's hash.
   *
   * @generated from field: string id = 1;
   */
  id: string;

  /**
   * The name to show, 1 to 200 characters.
   *
   * @generated from field: string name = 2;
   */
  name: string;

  /**
   * "image/png", "image/jpeg", "image/webp" or "image/gif", as the bytes
   * start, whatever the file claimed.
   *
   * @generated from field: string media_type = 3;
   */
  mediaType: string;

  /**
   * The size in bytes, a positive whole number.
   *
   * @generated from field: double size = 4;
   */
  size: number;
};

/**
 * Describes the message doric.runtime.attachments.v1.Attachment.
 * Use `create(AttachmentSchema)` to create a new message.
 */
export const AttachmentSchema: GenMessage<Attachment> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 0);

/**
 * The first item of an `Attach` stream.
 *
 * @generated from message doric.runtime.attachments.v1.AttachHead
 */
export type AttachHead = Message<'doric.runtime.attachments.v1.AttachHead'> & {
  /**
   * The name to show; a reference line writes it on one line, without
   * brackets, "image" when nothing is left.
   *
   * @generated from field: string name = 1;
   */
  name: string;
};

/**
 * Describes the message doric.runtime.attachments.v1.AttachHead.
 * Use `create(AttachHeadSchema)` to create a new message.
 */
export const AttachHeadSchema: GenMessage<AttachHead> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 1);

/**
 * One item an `Attach` caller sends: the head first, and only first, then
 * the image's bytes in chunks; the image is the chunks' concatenation.
 *
 * @generated from message doric.runtime.attachments.v1.AttachRequest
 */
export type AttachRequest =
  Message<'doric.runtime.attachments.v1.AttachRequest'> & {
    /**
     * The item.
     *
     * @generated from oneof doric.runtime.attachments.v1.AttachRequest.item
     */
    item:
      | {
          /**
           * The name; the first item.
           *
           * @generated from field: doric.runtime.attachments.v1.AttachHead head = 1;
           */
          value: AttachHead;
          case: 'head';
        }
      | {
          /**
           * The image's next bytes, at most 1 MiB.
           *
           * @generated from field: bytes chunk = 2;
           */
          value: Uint8Array;
          case: 'chunk';
        }
      | { case: undefined; value?: undefined };
  };

/**
 * Describes the message doric.runtime.attachments.v1.AttachRequest.
 * Use `create(AttachRequestSchema)` to create a new message.
 */
export const AttachRequestSchema: GenMessage<AttachRequest> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 2);

/**
 * The kept image.
 *
 * @generated from message doric.runtime.attachments.v1.AttachResponse
 */
export type AttachResponse =
  Message<'doric.runtime.attachments.v1.AttachResponse'> & {
    /**
     * The attachment.
     *
     * @generated from field: doric.runtime.attachments.v1.Attachment attachment = 1;
     */
    attachment?: Attachment | undefined;
  };

/**
 * Describes the message doric.runtime.attachments.v1.AttachResponse.
 * Use `create(AttachResponseSchema)` to create a new message.
 */
export const AttachResponseSchema: GenMessage<AttachResponse> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 3);

/**
 * Asks one attachment.
 *
 * @generated from message doric.runtime.attachments.v1.ReadRequest
 */
export type ReadRequest =
  Message<'doric.runtime.attachments.v1.ReadRequest'> & {
    /**
     * The attachment's id.
     *
     * @generated from field: string id = 1;
     */
    id: string;
  };

/**
 * Describes the message doric.runtime.attachments.v1.ReadRequest.
 * Use `create(ReadRequestSchema)` to create a new message.
 */
export const ReadRequestSchema: GenMessage<ReadRequest> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 4);

/**
 * The first item of a `Read` stream.
 *
 * @generated from message doric.runtime.attachments.v1.ReadHead
 */
export type ReadHead = Message<'doric.runtime.attachments.v1.ReadHead'> & {
  /**
   * The attachment; absent when the Project holds none by that id, and then
   * no chunk follows.
   *
   * @generated from field: optional doric.runtime.attachments.v1.Attachment attachment = 1;
   */
  attachment?: Attachment | undefined;
};

/**
 * Describes the message doric.runtime.attachments.v1.ReadHead.
 * Use `create(ReadHeadSchema)` to create a new message.
 */
export const ReadHeadSchema: GenMessage<ReadHead> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 5);

/**
 * One item of a `Read` stream: the head first, and only first, then the
 * image's bytes in chunks.
 *
 * @generated from message doric.runtime.attachments.v1.ReadResponse
 */
export type ReadResponse =
  Message<'doric.runtime.attachments.v1.ReadResponse'> & {
    /**
     * The item.
     *
     * @generated from oneof doric.runtime.attachments.v1.ReadResponse.item
     */
    item:
      | {
          /**
           * What the attachment is; the first item.
           *
           * @generated from field: doric.runtime.attachments.v1.ReadHead head = 1;
           */
          value: ReadHead;
          case: 'head';
        }
      | {
          /**
           * The image's next bytes, at most 1 MiB.
           *
           * @generated from field: bytes chunk = 2;
           */
          value: Uint8Array;
          case: 'chunk';
        }
      | { case: undefined; value?: undefined };
  };

/**
 * Describes the message doric.runtime.attachments.v1.ReadResponse.
 * Use `create(ReadResponseSchema)` to create a new message.
 */
export const ReadResponseSchema: GenMessage<ReadResponse> =
  /*@__PURE__*/
  messageDesc(file_doric_runtime_attachments_v1_attachments, 6);

/**
 * The images of the calling Project.
 *
 * @generated from service doric.runtime.attachments.v1.AttachmentsService
 */
export const AttachmentsService: GenService<{
  /**
   * Keeps an image for the Project and answers its attachment: a head, then
   * the bytes in chunks. Fails with `INVALID_ARGUMENT` for bytes that are
   * not a PNG, JPEG, WebP or GIF image, or that are empty or larger than
   * 5 MiB. The same bytes again answer the same id.
   *
   * @generated from rpc doric.runtime.attachments.v1.AttachmentsService.Attach
   */
  attach: {
    methodKind: 'client_streaming';
    input: typeof AttachRequestSchema;
    output: typeof AttachResponseSchema;
  };
  /**
   * One attachment of the Project, bytes and all: a head, then, when the
   * Project holds it, its bytes in chunks of at most 1 MiB.
   *
   * @generated from rpc doric.runtime.attachments.v1.AttachmentsService.Read
   */
  read: {
    methodKind: 'server_streaming';
    input: typeof ReadRequestSchema;
    output: typeof ReadResponseSchema;
  };
}> =
  /*@__PURE__*/
  serviceDesc(file_doric_runtime_attachments_v1_attachments, 0);
