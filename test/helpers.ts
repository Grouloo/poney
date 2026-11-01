// What the tests share: the shape of the requests their fake model servers receive.
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import type { Config } from '../src/types.ts';

export interface ModelMessage {
  role: string;
  content: string;
  thinking?: string;
  tool_call_id?: string;
  tool_calls?: { id?: string; function: { name: string; arguments: string | Record<string, unknown> } }[];
}

/** A request to a fake server: the fields of the API it stands for, as sent by src/agent/llm.ts. */
export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  stream?: boolean;
  think?: boolean | string;
  format?: unknown;
  tools?: { function: { name: string; description: string; parameters: unknown } }[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  options?: Record<string, number>;
  keep_alive?: unknown;
  grammar?: string;
  prompt?: string;
  cache_prompt?: boolean;
  [key: string]: unknown;
}

/** A reply of a fake server. */
export interface ModelReply {
  content?: string;
  thinking?: string;
  tool_calls?: ModelMessage['tool_calls'];
}

/** The port of a server already listening. */
export const port = (server: Server) => (server.address() as AddressInfo).port;

/** A fake model server. */
export interface Fake {
  server: HttpServer;
  requests: ModelRequest[];
  url: string;
}

/** What a fake server answers to a request, the nth one. */
export type Reply<T = string> = (request: ModelRequest, n: number) => T;

/** A settings object with only what the test needs: the code reads the rest as unset. */
export const cfg = (config: Partial<Config> = {}) => config as Config;
