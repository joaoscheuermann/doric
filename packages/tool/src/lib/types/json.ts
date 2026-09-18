export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
